/** Phase 19 B4 cross-provider static-contract and dialect-retention gate. */

import { afterEach, describe, expect, it } from "vitest";
import {
    clearRegistry,
    disableAdapter,
    enableAdapter,
    freezeRegistry,
    getRegisteredVersionDialectRegistry,
    registerAdapterProvider,
} from "../../packages/core/src/orchestration/adapter-registry";
import type { AdapterProvider, AgentRuntimeId, AssetKind, EntrySupportStatus } from "../../packages/core/src/types";
import { ASSET_KINDS, BUILTIN_ADAPTER_PROVIDERS } from "./adapter-conformance-fixtures";

const PROVIDERS = BUILTIN_ADAPTER_PROVIDERS;

type ExpectedCellMatrix = Record<AgentRuntimeId, Record<AssetKind, EntrySupportStatus>>;
type ExpectedSourceStatus = EntrySupportStatus | readonly EntrySupportStatus[];
type ExpectedSourceCellMatrix = Record<AgentRuntimeId, Record<AssetKind, ExpectedSourceStatus>>;
type SourceDispositionRow = {
    entrySupportStatus: EntrySupportStatus;
    readPolicy: "auto_read" | "user_selected_root_only" | "report_only";
    diagnostics: readonly unknown[];
};

const SOURCE_STATUS: ExpectedSourceCellMatrix = {
    CLAUDE_CODE_CLI: allKinds("supported"),
    CLAUDE_CODE_APP: allKinds("supported"),
    ANTIGRAVITY_CLI: {
        ...allKinds("supported"),
        Memory: "unsupported",
    },
    ANTIGRAVITY_APP: {
        ...allKinds("supported"),
        Skill: ["supported", "docs_declared_unverified"],
        Memory: "unsupported",
    },
    ANTIGRAVITY_IDE: {
        Guidance: "supported",
        Rule: "supported",
        Workflow: "supported",
        Skill: ["supported", "docs_declared_unverified"],
        Subagent: "unsupported",
        Memory: "unsupported",
    },
    OPENCODE_CLI: {
        Guidance: "supported",
        Rule: "unsupported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "unsupported",
    },
    OPENCODE_APP: {
        Guidance: "supported",
        Rule: "unsupported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "unsupported",
    },
    CODEX_CLI: {
        Guidance: "supported",
        Rule: "unsupported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "supported",
    },
    CODEX_APP: {
        Guidance: "supported",
        Rule: "unsupported",
        Workflow: "unsupported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "supported",
    },
    ZCODE_APP: {
        Guidance: "supported",
        Rule: "unsupported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "supported",
    },
    CURSOR_AGENT_CLI: {
        Guidance: "supported",
        Rule: "supported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "deferred",
    },
    CURSOR_APP: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Memory: "supported",
        Rule: "supported",
        Skill: "supported",
        Subagent: "supported",
        Workflow: "supported",
    },
};

const TARGET_STATUS: ExpectedCellMatrix = {
    CLAUDE_CODE_CLI: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Rule: "supported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "supported",
    },
    CLAUDE_CODE_APP: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Rule: "supported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "supported",
    },
    ANTIGRAVITY_CLI: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Rule: "supported",
        Workflow: "unsupported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "unsupported",
    },
    ANTIGRAVITY_APP: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Rule: "supported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "unsupported",
    },
    ANTIGRAVITY_IDE: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Rule: "supported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "unsupported",
        Memory: "unsupported",
    },
    OPENCODE_CLI: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Rule: "unsupported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "unsupported",
    },
    OPENCODE_APP: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Rule: "unsupported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "unsupported",
    },
    CODEX_CLI: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Rule: "unsupported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
    },
    CODEX_APP: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Rule: "unsupported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
    },
    ZCODE_APP: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Rule: "unsupported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "supported",
    },
    CURSOR_AGENT_CLI: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Rule: "supported",
        Skill: "supported",
        Workflow: "supported",
        Subagent: "supported",
    },
    CURSOR_APP: {
        ...allKinds("deferred"),
        Guidance: "supported",
        Rule: "supported",
        Workflow: "supported",
        Skill: "supported",
        Subagent: "supported",
        Memory: "unsupported",
    },
};

afterEach(() => clearRegistry());

describe("Phase 19 B4 cross-provider conformance", () => {
    it("owns the exact built-in agent-runtime entries and a complete source/target cell matrix", () => {
        const runtimeOwners = new Map<AgentRuntimeId, AdapterProvider>();
        for (const provider of PROVIDERS) {
            for (const descriptor of provider.agentRuntimes) {
                expect(runtimeOwners.has(descriptor.agentRuntimeId)).toBe(false);
                runtimeOwners.set(descriptor.agentRuntimeId, provider);
            }
        }

        expect([...runtimeOwners.keys()].sort()).toEqual(Object.keys(SOURCE_STATUS).sort());
        expect(Object.keys(TARGET_STATUS).sort()).toEqual(Object.keys(SOURCE_STATUS).sort());

        for (const [agentRuntimeId, provider] of runtimeOwners) {
            for (const assetKind of ASSET_KINDS) {
                const sourceRows = provider.assetSourceCapabilities.filter(
                    (row) => row.agentRuntimeId === agentRuntimeId && row.assetKind === assetKind,
                );
                const targetRows = provider.assetTargetCapabilities.filter(
                    (row) => row.agentRuntimeId === agentRuntimeId && row.assetKind === assetKind,
                );
                expect(sourceRows.length, `${agentRuntimeId}/${assetKind} source`).toBeGreaterThan(0);
                const cell = `${agentRuntimeId}/${assetKind}`;
                expect(targetRows, `${cell} target`).toHaveLength(expectedTargetRowCount(cell, assetKind));
            }
        }
    });

    it("matches every source cell to the evidence-backed supported/report-only/unsupported state", () => {
        for (const provider of PROVIDERS) {
            for (const descriptor of provider.agentRuntimes) {
                for (const assetKind of ASSET_KINDS) {
                    const rows = provider.assetSourceCapabilities.filter(
                        (row) => row.agentRuntimeId === descriptor.agentRuntimeId && row.assetKind === assetKind,
                    );
                    const summary = summarizeSourceDispositions(rows);
                    expect(summary.statuses, `${descriptor.agentRuntimeId}/${assetKind} source status`).toEqual(
                        expectedSourceStatuses(SOURCE_STATUS[descriptor.agentRuntimeId]?.[assetKind]),
                    );
                    expect(summary.violations, `${descriptor.agentRuntimeId}/${assetKind} source policy`).toEqual([]);
                }
            }
        }
    });

    it("represents mixed callable and report-only source rows without weakening either policy", () => {
        expect(
            summarizeSourceDispositions([
                { entrySupportStatus: "supported", readPolicy: "auto_read", diagnostics: [] },
                {
                    entrySupportStatus: "docs_declared_unverified",
                    readPolicy: "report_only",
                    diagnostics: [{ code: "fixture_unverified" }],
                },
            ]),
        ).toEqual({ statuses: ["docs_declared_unverified", "supported"], violations: [] });
        expect(
            summarizeSourceDispositions([
                { entrySupportStatus: "supported", readPolicy: "report_only", diagnostics: [] },
                { entrySupportStatus: "deferred", readPolicy: "auto_read", diagnostics: [] },
            ]).violations,
        ).toEqual([
            "row 0: supported source is report-only",
            "row 1: deferred source is callable",
            "row 1: deferred source has no diagnostic",
        ]);
    });

    it("keeps every exact supported cell and target variant honest", () => {
        const supportedCells: string[] = [];
        for (const provider of PROVIDERS) {
            for (const descriptor of provider.agentRuntimes) {
                for (const assetKind of ASSET_KINDS) {
                    const rows = provider.assetTargetCapabilities.filter(
                        (candidate) =>
                            candidate.agentRuntimeId === descriptor.agentRuntimeId && candidate.assetKind === assetKind,
                    );
                    const expectedStatus = TARGET_STATUS[descriptor.agentRuntimeId]?.[assetKind];
                    expect(
                        new Set(rows.map((row) => row.entrySupportStatus)),
                        `${descriptor.agentRuntimeId}/${assetKind} status`,
                    ).toEqual(new Set([expectedStatus]));
                    const cell = `${descriptor.agentRuntimeId}/${assetKind}`;
                    if (expectedStatus === "supported") {
                        supportedCells.push(cell);
                        expect(rows.every((row) => row.diagnostics.length === 0)).toBe(true);
                        if (cell === "CLAUDE_CODE_CLI/Workflow") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual(
                                [
                                    "native_graph:CLAUDECODE_NATIVE_PROJECT_WORKFLOW_COMMAND_V1_CANONICAL_V1",
                                    "native_graph:CLAUDECODE_NATIVE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_V1",
                                    "native_graph:CLAUDECODE_NATIVE_GLOBAL_WORKFLOW_COMMAND_GRAPH_V1_CANONICAL_V1",
                                    "native_graph:CLAUDECODE_NATIVE_PROJECT_JAVASCRIPT_WORKFLOW_GRAPH_V1",
                                ].sort(),
                            );
                        } else if (cell === "CLAUDE_CODE_APP/Workflow") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual(
                                [
                                    "native_graph:CLAUDECODE_APP_NATIVE_PROJECT_WORKFLOW_COMMAND_V1_CANONICAL_V1",
                                    "native_graph:CLAUDECODE_APP_NATIVE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_V1",
                                    "native_graph:CLAUDECODE_APP_NATIVE_GLOBAL_WORKFLOW_COMMAND_GRAPH_V1_CANONICAL_V1",
                                    "native_graph:CLAUDECODE_APP_NATIVE_PROJECT_JAVASCRIPT_WORKFLOW_GRAPH_V1",
                                ].sort(),
                            );
                        } else if (cell === "CLAUDE_CODE_CLI/Memory" || cell === "CLAUDE_CODE_APP/Memory") {
                            const prefix = cell === "CLAUDE_CODE_APP/Memory" ? "CLAUDECODE_APP" : "CLAUDECODE";
                            const expectedMaterializers =
                                cell === "CLAUDE_CODE_APP/Memory"
                                    ? [
                                          "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_CATALOG_V1:claudecode.app-project-memory-catalog-exact-file-v1",
                                          "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_TOPIC_V1:claudecode.app-project-memory-topic-exact-file-v1",
                                      ]
                                    : [
                                          "CLAUDECODE_NATIVE_PROJECT_MEMORY_CATALOG_V1:claudecode.project-memory-catalog-exact-file-v1",
                                          "CLAUDECODE_NATIVE_PROJECT_MEMORY_TOPIC_V1:claudecode.project-memory-exact-file-v1",
                                      ];
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                `native_file:${prefix}_NATIVE_PROJECT_MEMORY_CATALOG_V1`,
                                `native_file:${prefix}_NATIVE_PROJECT_MEMORY_TOPIC_V1`,
                            ]);
                            expect(
                                provider.materializerCapabilities
                                    .filter((capability) =>
                                        rows.some(
                                            (row) =>
                                                "outputContractId" in row && row.outputContractId === capability.outputContractId,
                                        ),
                                    )
                                    .map((capability) => `${capability.outputContractId}:${capability.materializerCapabilityKey}`)
                                    .sort(),
                            ).toEqual(expectedMaterializers);
                        } else if (cell === "CLAUDE_CODE_CLI/Rule") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_file:CLAUDECODE_NATIVE_GLOBAL_RULE_V1",
                                "native_file:CLAUDECODE_NATIVE_PROJECT_RULE_EXACT_FILE_V1",
                                "native_file:CLAUDECODE_NATIVE_PROJECT_RULE_V1",
                                "native_graph:CLAUDECODE_NATIVE_GLOBAL_RULE_EXACT_GRAPH_V1",
                            ]);
                        } else if (cell === "CLAUDE_CODE_APP/Rule") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_file:CLAUDECODE_APP_NATIVE_GLOBAL_RULE_V1",
                                "native_file:CLAUDECODE_APP_NATIVE_PROJECT_RULE_EXACT_FILE_V1",
                                "native_file:CLAUDECODE_APP_NATIVE_PROJECT_RULE_V1",
                                "native_graph:CLAUDECODE_APP_NATIVE_GLOBAL_RULE_EXACT_GRAPH_V1",
                            ]);
                        } else if (cell === "ANTIGRAVITY_CLI/Skill") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_graph:ANTIGRAVITY_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
                                "native_graph:ANTIGRAVITY_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                            ]);
                        } else if (cell === "ZCODE_APP/Workflow") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_graph:ZCODE_NATIVE_GLOBAL_COMMAND_WORKFLOW_V1",
                                "native_graph:ZCODE_NATIVE_PROJECT_COMMAND_WORKFLOW_V1",
                            ]);
                        } else if (cell === "OPENCODE_CLI/Workflow" || cell === "OPENCODE_APP/Workflow") {
                            const outputPrefix = cell === "OPENCODE_APP/Workflow" ? "OPENCODE_APP" : "OPENCODE_CLI";
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                `native_graph:${outputPrefix}_NATIVE_GLOBAL_WORKFLOW_MARKDOWN_V1`,
                                `native_graph:${outputPrefix}_NATIVE_PROJECT_WORKFLOW_MARKDOWN_V1`,
                            ]);
                        } else if (cell === "OPENCODE_CLI/Skill" || cell === "OPENCODE_APP/Skill") {
                            const outputPrefix = cell === "OPENCODE_APP/Skill" ? "OPENCODE_APP" : "OPENCODE_CLI";
                            const interpretation = cell === "OPENCODE_APP/Skill" ? 1 : 2;
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                `native_graph:${outputPrefix}_NATIVE_GLOBAL_CONFIG_SKILL_DIRECTORY_V${interpretation}`,
                                `native_graph:${outputPrefix}_NATIVE_PROJECT_SKILL_DIRECTORY_V${interpretation}`,
                                `native_graph:${outputPrefix}_NATIVE_SHARED_SKILL_DIRECTORY_V${interpretation}`,
                            ]);
                        } else if (cell === "OPENCODE_CLI/Subagent" || cell === "OPENCODE_APP/Subagent") {
                            const outputPrefix = cell === "OPENCODE_APP/Subagent" ? "OPENCODE_APP" : "OPENCODE_CLI";
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                `native_graph:${outputPrefix}_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1`,
                                `native_graph:${outputPrefix}_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1`,
                            ]);
                        } else if (cell === "ZCODE_APP/Skill") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_graph:ZCODE_NATIVE_GLOBAL_CONFIG_SKILL_DIRECTORY_V1",
                                "native_graph:ZCODE_NATIVE_GLOBAL_DIRECT_SKILL_DIRECTORY_V1",
                                "native_graph:ZCODE_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                            ]);
                        } else if (cell === "ZCODE_APP/Subagent") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_graph:ZCODE_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1",
                                "native_graph:ZCODE_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1",
                            ]);
                        } else if (cell === "ZCODE_APP/Memory") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_file:ZCODE_NATIVE_PROJECT_MEMORY_CATALOG_V1",
                                "native_file:ZCODE_NATIVE_PROJECT_MEMORY_TOPIC_V1",
                            ]);
                            expect(
                                provider.materializerCapabilities
                                    .filter((capability) =>
                                        rows.some(
                                            (row) =>
                                                "outputContractId" in row && row.outputContractId === capability.outputContractId,
                                        ),
                                    )
                                    .map((capability) => `${capability.outputContractId}:${capability.materializerCapabilityKey}`)
                                    .sort(),
                            ).toEqual([
                                "ZCODE_NATIVE_PROJECT_MEMORY_CATALOG_V1:zcode.project-memory-catalog-exact-file-v1",
                                "ZCODE_NATIVE_PROJECT_MEMORY_TOPIC_V1:zcode.project-memory-topic-exact-file-v1",
                            ]);
                        } else if (cell === "ANTIGRAVITY_CLI/Subagent") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_graph:ANTIGRAVITY_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1",
                                "native_graph:ANTIGRAVITY_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1",
                            ]);
                        } else if (cell === "ANTIGRAVITY_IDE/Guidance") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_file:ANTIGRAVITY_IDE_NATIVE_GLOBAL_GUIDANCE_V1",
                                "native_file:ANTIGRAVITY_IDE_NATIVE_PROJECT_GUIDANCE_V1",
                            ]);
                        } else if (cell === "ANTIGRAVITY_IDE/Workflow") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_graph:ANTIGRAVITY_IDE_NATIVE_GLOBAL_WORKFLOW_MARKDOWN_V1",
                                "native_graph:ANTIGRAVITY_IDE_NATIVE_PROJECT_WORKFLOW_MARKDOWN_V1",
                            ]);
                        } else if (cell === "ANTIGRAVITY_IDE/Skill") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_graph:ANTIGRAVITY_IDE_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
                                "native_graph:ANTIGRAVITY_IDE_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                            ]);
                        } else if (cell === "ANTIGRAVITY_APP/Guidance") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_file:ANTIGRAVITY_APP_NATIVE_GLOBAL_GUIDANCE_V1",
                                "native_file:ANTIGRAVITY_APP_NATIVE_PROJECT_GUIDANCE_V1",
                            ]);
                        } else if (cell === "ANTIGRAVITY_APP/Workflow") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_graph:ANTIGRAVITY_APP_NATIVE_GLOBAL_WORKFLOW_MARKDOWN_V1",
                                "native_graph:ANTIGRAVITY_APP_NATIVE_PROJECT_WORKFLOW_MARKDOWN_V1",
                            ]);
                        } else if (cell === "ANTIGRAVITY_APP/Skill") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_graph:ANTIGRAVITY_APP_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
                                "native_graph:ANTIGRAVITY_APP_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                            ]);
                        } else if (cell === "ANTIGRAVITY_APP/Subagent") {
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                "native_graph:ANTIGRAVITY_APP_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1",
                                "native_graph:ANTIGRAVITY_APP_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1",
                            ]);
                        } else if (cell === "CODEX_CLI/Workflow" || cell === "CODEX_APP/Workflow") {
                            const outputPrefix = cell === "CODEX_APP/Workflow" ? "CODEX_APP_NATIVE" : "CODEX_NATIVE";
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                `native_graph:${outputPrefix}_GLOBAL_WORKFLOW_AS_SKILL_V1`,
                                `native_graph:${outputPrefix}_PROJECT_WORKFLOW_AS_SKILL_V1`,
                            ]);
                        } else if (cell === "CODEX_CLI/Skill" || cell === "CODEX_APP/Skill") {
                            const outputPrefix = cell === "CODEX_APP/Skill" ? "CODEX_APP_NATIVE" : "CODEX_NATIVE";
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                `native_graph:${outputPrefix}_GLOBAL_SKILL_DIRECTORY_V1`,
                                `native_graph:${outputPrefix}_PROJECT_SKILL_DIRECTORY_V1`,
                            ]);
                        } else if (
                            cell === "CODEX_CLI/Guidance" ||
                            cell === "CODEX_APP/Guidance" ||
                            cell === "CODEX_CLI/Subagent" ||
                            cell === "CODEX_APP/Subagent"
                        ) {
                            const outputPrefix = cell.startsWith("CODEX_APP/") ? "CODEX_APP_NATIVE" : "CODEX_NATIVE";
                            const suffix = assetKind === "Guidance" ? "GUIDANCE_V1" : "SUBAGENT_ONE_FILE_V1";
                            const expectedVariants =
                                assetKind === "Guidance"
                                    ? [
                                          `native_file:${outputPrefix}_GLOBAL_${suffix}`,
                                          `native_file:${outputPrefix}_PROJECT_${suffix}`,
                                      ]
                                    : [
                                          `native_graph:${outputPrefix}_GLOBAL_${suffix}`,
                                          `native_file:${outputPrefix}_PROJECT_${suffix}`,
                                      ];
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual(expectedVariants.sort());
                        } else if (cell === "CURSOR_AGENT_CLI/Workflow" || cell === "CURSOR_APP/Workflow") {
                            const outputPrefix = cell === "CURSOR_APP/Workflow" ? "CURSOR_APP_NATIVE" : "CURSOR_AGENT_CLI_NATIVE";
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                `native_graph:${outputPrefix}_GLOBAL_WORKFLOW_V1`,
                                `native_graph:${outputPrefix}_PROJECT_WORKFLOW_V1`,
                            ]);
                        } else if (cell === "CURSOR_AGENT_CLI/Skill" || cell === "CURSOR_APP/Skill") {
                            const outputPrefix = cell === "CURSOR_APP/Skill" ? "CURSOR_APP_NATIVE" : "CURSOR_AGENT_CLI_NATIVE";
                            expect(
                                rows
                                    .map((row) =>
                                        "renderStrategy" in row
                                            ? `${row.renderStrategy}:${row.outputContractId}`
                                            : row.entrySupportStatus,
                                    )
                                    .sort(),
                            ).toEqual([
                                `native_graph:${outputPrefix}_GLOBAL_CONFIG_SKILL_DIRECTORY_V1`,
                                `native_graph:${outputPrefix}_GLOBAL_DIRECT_SKILL_DIRECTORY_V1`,
                                `native_graph:${outputPrefix}_PROJECT_SKILL_DIRECTORY_V1`,
                            ]);
                        } else if (cell === "CURSOR_AGENT_CLI/Subagent" || cell === "CURSOR_APP/Subagent") {
                            const outputPrefix = cell === "CURSOR_APP/Subagent" ? "CURSOR_APP_NATIVE" : "CURSOR_AGENT_CLI_NATIVE";
                            expect(
                                rows.map((row) =>
                                    "renderStrategy" in row
                                        ? `${row.renderStrategy}:${row.outputContractId}`
                                        : row.entrySupportStatus,
                                ),
                            ).toEqual([`native_graph:${outputPrefix}_PROJECT_SUBAGENT_V1`]);
                        } else if (cell === "CURSOR_APP/Rule") {
                            expect(
                                rows.map((row) =>
                                    "renderStrategy" in row
                                        ? `${row.renderStrategy}:${row.outputContractId}`
                                        : row.entrySupportStatus,
                                ),
                            ).toEqual(["native_file:CURSOR_APP_NATIVE_PROJECT_RULE_MDC_V1"]);
                        } else {
                            const expectedStrategy =
                                cell === "CLAUDE_CODE_CLI/Skill" ||
                                cell === "CLAUDE_CODE_CLI/Subagent" ||
                                cell === "CLAUDE_CODE_APP/Skill" ||
                                cell === "CLAUDE_CODE_APP/Subagent"
                                    ? "native_graph"
                                    : "native_file";
                            const expectedCount = cell.startsWith("CLAUDE_CODE_") ? 2 : 1;
                            expect(rows.map((row) => ("renderStrategy" in row ? row.renderStrategy : null))).toEqual(
                                Array.from({ length: expectedCount }, () => expectedStrategy),
                            );
                        }
                        expect(
                            rows.every((row) => "reverseExtractPolicy" in row && row.reverseExtractPolicy === "can_reconcile"),
                        ).toBe(true);
                    } else {
                        expect(rows).toHaveLength(1);
                        expect(rows[0]?.diagnostics.length).toBeGreaterThan(0);
                    }
                }
            }
        }
        expect(supportedCells.sort()).toEqual([
            "ANTIGRAVITY_APP/Guidance",
            "ANTIGRAVITY_APP/Rule",
            "ANTIGRAVITY_APP/Skill",
            "ANTIGRAVITY_APP/Subagent",
            "ANTIGRAVITY_APP/Workflow",
            "ANTIGRAVITY_CLI/Guidance",
            "ANTIGRAVITY_CLI/Rule",
            "ANTIGRAVITY_CLI/Skill",
            "ANTIGRAVITY_CLI/Subagent",
            "ANTIGRAVITY_IDE/Guidance",
            "ANTIGRAVITY_IDE/Rule",
            "ANTIGRAVITY_IDE/Skill",
            "ANTIGRAVITY_IDE/Workflow",
            "CLAUDE_CODE_APP/Guidance",
            "CLAUDE_CODE_APP/Memory",
            "CLAUDE_CODE_APP/Rule",
            "CLAUDE_CODE_APP/Skill",
            "CLAUDE_CODE_APP/Subagent",
            "CLAUDE_CODE_APP/Workflow",
            "CLAUDE_CODE_CLI/Guidance",
            "CLAUDE_CODE_CLI/Memory",
            "CLAUDE_CODE_CLI/Rule",
            "CLAUDE_CODE_CLI/Skill",
            "CLAUDE_CODE_CLI/Subagent",
            "CLAUDE_CODE_CLI/Workflow",
            "CODEX_APP/Guidance",
            "CODEX_APP/Skill",
            "CODEX_APP/Subagent",
            "CODEX_APP/Workflow",
            "CODEX_CLI/Guidance",
            "CODEX_CLI/Skill",
            "CODEX_CLI/Subagent",
            "CODEX_CLI/Workflow",
            "CURSOR_AGENT_CLI/Guidance",
            "CURSOR_AGENT_CLI/Rule",
            "CURSOR_AGENT_CLI/Skill",
            "CURSOR_AGENT_CLI/Subagent",
            "CURSOR_AGENT_CLI/Workflow",
            "CURSOR_APP/Guidance",
            "CURSOR_APP/Rule",
            "CURSOR_APP/Skill",
            "CURSOR_APP/Subagent",
            "CURSOR_APP/Workflow",
            "OPENCODE_APP/Guidance",
            "OPENCODE_APP/Skill",
            "OPENCODE_APP/Subagent",
            "OPENCODE_APP/Workflow",
            "OPENCODE_CLI/Guidance",
            "OPENCODE_CLI/Skill",
            "OPENCODE_CLI/Subagent",
            "OPENCODE_CLI/Workflow",
            "ZCODE_APP/Guidance",
            "ZCODE_APP/Memory",
            "ZCODE_APP/Skill",
            "ZCODE_APP/Subagent",
            "ZCODE_APP/Workflow",
        ]);
        expect(
            PROVIDERS.flatMap((provider) => provider.targetContextSchemas)
                .map((schema) => schema.agentRuntimeId)
                .sort(),
        ).toEqual([
            "ANTIGRAVITY_APP",
            "ANTIGRAVITY_APP",
            "ANTIGRAVITY_CLI",
            "ANTIGRAVITY_CLI",
            "ANTIGRAVITY_IDE",
            "ANTIGRAVITY_IDE",
            "CLAUDE_CODE_APP",
            "CLAUDE_CODE_APP",
            "CLAUDE_CODE_APP",
            "CLAUDE_CODE_CLI",
            "CLAUDE_CODE_CLI",
            "CLAUDE_CODE_CLI",
            "CODEX_APP",
            "CODEX_APP",
            "CODEX_APP",
            "CODEX_CLI",
            "CODEX_CLI",
            "CODEX_CLI",
            "CURSOR_AGENT_CLI",
            "CURSOR_AGENT_CLI",
            "CURSOR_AGENT_CLI",
            "CURSOR_APP",
            "CURSOR_APP",
            "CURSOR_APP",
            "OPENCODE_APP",
            "OPENCODE_APP",
            "OPENCODE_APP",
            "OPENCODE_APP",
            "OPENCODE_APP",
            "OPENCODE_APP",
            "OPENCODE_APP",
            "OPENCODE_CLI",
            "OPENCODE_CLI",
            "OPENCODE_CLI",
            "OPENCODE_CLI",
            "OPENCODE_CLI",
            "OPENCODE_CLI",
            "OPENCODE_CLI",
            "ZCODE_APP",
            "ZCODE_APP",
            "ZCODE_APP",
            "ZCODE_APP",
        ]);
        expect(PROVIDERS.flatMap((provider) => provider.materializerCapabilities)).toHaveLength(112);
    });

    it("registers a native dialect for every callable source kind and every restoration contract", () => {
        for (const provider of PROVIDERS) {
            const supportedKinds = uniqueSorted(
                provider.assetSourceCapabilities
                    .filter((row) => row.entrySupportStatus === "supported")
                    .map((row) => row.assetKind),
            );
            const nativeKinds = new Set(provider.dialectContracts.native.map((contract) => contract.definition.kind));
            for (const supportedKind of supportedKinds) {
                expect(nativeKinds.has(supportedKind), `${provider.adapterId}/${supportedKind}`).toBe(true);
            }

            const nativeKeys = new Set(
                provider.dialectContracts.native.map(
                    (contract) => `${contract.definition.kind}\0${contract.definition.dialectId}`,
                ),
            );
            for (const restoration of provider.dialectContracts.restoration) {
                expect(nativeKeys.has(`${restoration.definition.kind}\0${restoration.definition.dialectId}`)).toBe(true);
            }
        }
    });

    it("retains every registered historical dialect after all providers are disabled", () => {
        for (const provider of PROVIDERS) {
            expect(registerAdapterProvider(provider), provider.adapterId).toMatchObject({ status: "complete", diagnostics: [] });
            expect(enableAdapter(provider.adapterId).status).toBe("complete");
        }
        expect(freezeRegistry().status).toBe("complete");

        for (const provider of PROVIDERS) {
            expect(disableAdapter(provider.adapterId).status).toBe("complete");
        }
        const registry = getRegisteredVersionDialectRegistry();
        for (const provider of PROVIDERS) {
            for (const contract of provider.dialectContracts.native) {
                const registered = registry.getNative(contract.definition.kind, contract.definition.dialectId);
                expect(registered?.dialectId).toBe(contract.definition.dialectId);
                expect(registered?.contractFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
            }
            for (const contract of provider.dialectContracts.restoration) {
                const registered = registry.getRestoration(contract.definition.kind, contract.definition.dialectId);
                expect(registered?.dialectId).toBe(contract.definition.dialectId);
                expect(registered?.contractFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
            }
        }
    });
});

function allKinds(status: EntrySupportStatus): Record<AssetKind, EntrySupportStatus> {
    return Object.fromEntries(ASSET_KINDS.map((kind) => [kind, status])) as Record<AssetKind, EntrySupportStatus>;
}

function expectedTargetRowCount(cell: string, assetKind: AssetKind): number {
    if (cell === "CURSOR_AGENT_CLI/Workflow") return 2;
    if (cell === "CURSOR_AGENT_CLI/Skill") return 3;
    if (cell === "CURSOR_APP/Workflow") return 2;
    if (cell === "CURSOR_APP/Skill") return 3;
    if ((cell === "OPENCODE_CLI/Workflow" || cell === "OPENCODE_APP/Workflow") && assetKind === "Workflow") return 2;
    if ((cell === "OPENCODE_CLI/Skill" || cell === "OPENCODE_APP/Skill") && assetKind === "Skill") return 3;
    if ((cell === "OPENCODE_CLI/Subagent" || cell === "OPENCODE_APP/Subagent") && assetKind === "Subagent") return 2;
    if (cell === "ZCODE_APP/Workflow") return 2;
    if (cell === "ZCODE_APP/Skill") return 3;
    if (cell === "ZCODE_APP/Subagent") return 2;
    if (cell === "ZCODE_APP/Memory") return 2;
    if (cell === "ANTIGRAVITY_CLI/Skill" || cell === "ANTIGRAVITY_CLI/Subagent") return 2;
    if (cell === "ANTIGRAVITY_IDE/Guidance" || cell === "ANTIGRAVITY_IDE/Workflow" || cell === "ANTIGRAVITY_IDE/Skill") {
        return 2;
    }
    if (
        cell === "ANTIGRAVITY_APP/Guidance" ||
        cell === "ANTIGRAVITY_APP/Workflow" ||
        cell === "ANTIGRAVITY_APP/Skill" ||
        cell === "ANTIGRAVITY_APP/Subagent"
    ) {
        return 2;
    }
    if (cell.startsWith("CLAUDE_CODE_") && (assetKind === "Rule" || assetKind === "Workflow")) return 4;
    if (cell.startsWith("CLAUDE_CODE_")) return 2;
    if (
        (cell.startsWith("CODEX_CLI/") || cell.startsWith("CODEX_APP/")) &&
        (assetKind === "Guidance" || assetKind === "Workflow" || assetKind === "Skill" || assetKind === "Subagent")
    ) {
        return 2;
    }
    return 1;
}

function expectedSourceStatuses(expected: ExpectedSourceStatus | undefined): EntrySupportStatus[] {
    if (expected === undefined) return [];
    return [...new Set(Array.isArray(expected) ? expected : [expected])].sort();
}

function summarizeSourceDispositions(rows: readonly SourceDispositionRow[]): {
    statuses: EntrySupportStatus[];
    violations: string[];
} {
    const violations: string[] = [];
    rows.forEach((row, index) => {
        if (row.entrySupportStatus === "supported" && row.readPolicy === "report_only") {
            violations.push(`row ${index}: supported source is report-only`);
        }
        if (row.entrySupportStatus !== "supported" && row.readPolicy !== "report_only") {
            violations.push(`row ${index}: ${row.entrySupportStatus} source is callable`);
        }
        if (row.entrySupportStatus !== "supported" && row.diagnostics.length === 0) {
            violations.push(`row ${index}: ${row.entrySupportStatus} source has no diagnostic`);
        }
    });
    return {
        statuses: [...new Set(rows.map((row) => row.entrySupportStatus))].sort(),
        violations,
    };
}

function uniqueSorted(values: readonly AssetKind[]): AssetKind[] {
    return [...new Set(values)].sort();
}
