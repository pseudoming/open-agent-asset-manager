import type { AgentRuntimeId, AssetKind, EntrySupportStatus } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { codexProvider } from "../src/codex-provider";

type RetainedSourceExpectation = {
    agentRuntimeId: AgentRuntimeId;
    assetKind: AssetKind;
    entrySupportStatus: EntrySupportStatus;
    code: string;
    messageFragments: readonly string[];
    sourceDomain?: "family_shared";
};

const RETAINED_SOURCE_EXPECTATIONS: readonly RetainedSourceExpectation[] = [
    {
        agentRuntimeId: "CODEX_CLI",
        assetKind: "Rule",
        entrySupportStatus: "unsupported",
        code: "codex_cli_rule_source_unsupported",
        messageFragments: ["command-execution approval policy", "misclassify executable policy", "Reopen only"],
    },
    {
        agentRuntimeId: "CODEX_APP",
        assetKind: "Rule",
        entrySupportStatus: "unsupported",
        code: "codex_app_rule_source_unsupported",
        messageFragments: ["command-execution approval policy", "misclassify executable policy", "Reopen only"],
    },
    {
        agentRuntimeId: "CODEX_APP",
        assetKind: "Workflow",
        entrySupportStatus: "unsupported",
        code: "codex_app_workflow_source_unsupported",
        messageFragments: ["Workflow-to-Skill conversion", "wrong runtime", "native Workflow loader"],
    },
];

const RETAINED_TARGET_EXPECTATIONS = [
    {
        agentRuntimeId: "CODEX_CLI",
        assetKind: "Rule",
        entrySupportStatus: "unsupported",
        code: "codex_cli_rule_target_unsupported",
        messageFragments: ["command-execution approval policy", "change executable policy semantics", "Reopen only"],
    },
    {
        agentRuntimeId: "CODEX_APP",
        assetKind: "Rule",
        entrySupportStatus: "unsupported",
        code: "codex_app_rule_target_unsupported",
        messageFragments: ["command-execution approval policy", "change executable policy semantics", "Reopen only"],
    },
    {
        agentRuntimeId: "CODEX_CLI",
        assetKind: "Memory",
        entrySupportStatus: "deferred",
        code: "codex_cli_memory_target_deferred",
        messageFragments: ["loads the final Memory files", "without an OAAM receipt", "stable target owner"],
    },
    {
        agentRuntimeId: "CODEX_APP",
        assetKind: "Memory",
        entrySupportStatus: "deferred",
        code: "codex_app_memory_target_deferred",
        messageFragments: ["loads the final Memory files", "without an OAAM receipt", "stable target owner"],
    },
] as const;

describe("Codex retained capability dispositions", () => {
    it("gives every retained source subset an exact reason, risk, and reopening condition", () => {
        for (const expected of RETAINED_SOURCE_EXPECTATIONS) {
            const rows = codexProvider.assetSourceCapabilities.filter(
                (row) =>
                    row.agentRuntimeId === expected.agentRuntimeId &&
                    row.assetKind === expected.assetKind &&
                    (expected.sourceDomain === undefined || row.sourceDomain === expected.sourceDomain) &&
                    row.entrySupportStatus !== "supported",
            );
            expect(rows.length, `${expected.agentRuntimeId}/${expected.assetKind}`).toBeGreaterThan(0);
            for (const row of rows) {
                expect(row.entrySupportStatus).toBe(expected.entrySupportStatus);
                expect(row.diagnostics).toEqual([
                    expect.objectContaining({ code: expected.code, causeKind: "unsupported", retryable: false }),
                ]);
                for (const fragment of expected.messageFragments) expect(row.diagnostics[0]?.message).toContain(fragment);
            }
        }
    });

    it("gives every retained target cell its exact present-build risk and reopening evidence", () => {
        for (const expected of RETAINED_TARGET_EXPECTATIONS) {
            const row = codexProvider.assetTargetCapabilities.find(
                (candidate) => candidate.agentRuntimeId === expected.agentRuntimeId && candidate.assetKind === expected.assetKind,
            );
            expect(row).toMatchObject({
                entrySupportStatus: expected.entrySupportStatus,
                diagnostics: [expect.objectContaining({ code: expected.code, causeKind: "unsupported", retryable: false })],
            });
            for (const fragment of expected.messageFragments) expect(row?.diagnostics[0]?.message).toContain(fragment);
        }
    });

    it("does not fall back to the retired generic source or target explanation", () => {
        const retainedMessages = [
            ...codexProvider.assetSourceCapabilities
                .filter((row) => row.entrySupportStatus !== "supported")
                .flatMap((row) => row.diagnostics.map((item) => item.message)),
            ...codexProvider.assetTargetCapabilities
                .filter((row) => row.entrySupportStatus !== "supported")
                .flatMap((row) => row.diagnostics.map((item) => item.message)),
        ].join("\n");
        expect(retainedMessages).not.toContain("source is declared but not callable in this Provider version");
        expect(retainedMessages).not.toContain("target materialization and reverse remain blocked pending exact fixtures");
        expect(retainedMessages).not.toContain("no matching enabled-runtime fixture");
    });
});
