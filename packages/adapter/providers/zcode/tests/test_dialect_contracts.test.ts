import { describe, expect, it } from "vitest";
import type { PortableSelectorDialectFieldV1, PortableSelectorDialectUseV1 } from "@oaam/core";
import { zcodeProvider } from "../src/zcode-provider";

function selector(field: PortableSelectorDialectFieldV1) {
    const contract = zcodeProvider.dialectContracts.portableSelectors.find((row) => row.definition.field === field);
    if (contract === undefined) throw new Error(`missing ${field} contract`);
    return contract;
}

describe("ZCode portable dialect contracts", () => {
    it("accepts only exact Workflow and Subagent selector semantics", () => {
        const valid: PortableSelectorDialectUseV1[] = [
            {
                kind: "Workflow",
                field: "workflow_tool",
                dialectId: "zcode-command-tool-selector-v1",
                value: { valueKind: "selector", selector: "Read" },
            },
            {
                kind: "Workflow",
                field: "workflow_model",
                dialectId: "zcode-model-selector-v1",
                value: { valueKind: "relative_tier", selector: "glm-5", relativeTier: -1 },
            },
            {
                kind: "Subagent",
                field: "subagent_tool",
                dialectId: "zcode-subagent-tool-name-v1",
                value: { valueKind: "selector", selector: "Grep" },
            },
            {
                kind: "Subagent",
                field: "subagent_permission",
                dialectId: "zcode-permission-mode-v1",
                value: { valueKind: "permission_effect", selector: "plan", effect: "read_only" },
            },
            {
                kind: "Subagent",
                field: "subagent_model",
                dialectId: "zcode-model-selector-v1",
                value: { valueKind: "relative_tier", selector: "glm-5", relativeTier: -1 },
            },
            {
                kind: "Subagent",
                field: "subagent_turn_limit",
                dialectId: "zcode-max-turns-v1",
                value: { valueKind: "positive_limit", limit: 7 },
            },
            {
                kind: "Subagent",
                field: "subagent_color",
                dialectId: "zcode-color-v1",
                value: { valueKind: "selector", selector: "cyan" },
            },
        ];
        for (const use of valid) {
            const contract = selector(use.field);
            expect(contract.validateSelector(use), use.field).toBe(true);
            expect(contract.validateSourceApplicability({ agentRuntimeId: "ZCODE_APP", versionText: "fixture" })).toBe(true);
            expect(contract.validateSourceApplicability({ agentRuntimeId: "CODEX_CLI", versionText: "fixture" })).toBe(false);
        }

        const [workflowTool, workflowModel, subagentTool, subagentPermission, subagentModel, subagentTurnLimit, subagentColor] =
            valid;
        if (
            workflowTool === undefined ||
            workflowModel === undefined ||
            subagentTool === undefined ||
            subagentPermission === undefined ||
            subagentModel === undefined ||
            subagentTurnLimit === undefined ||
            subagentColor === undefined
        ) {
            throw new Error("incomplete selector fixture");
        }

        expect(
            selector("workflow_tool").validateSelector({ ...workflowTool, value: { valueKind: "selector", selector: " " } }),
        ).toBe(false);
        expect(
            selector("workflow_model").validateSelector({
                ...workflowModel,
                value: { valueKind: "relative_tier", selector: "glm-5", relativeTier: 5 },
            }),
        ).toBe(false);
        expect(
            selector("subagent_permission").validateSelector({
                ...subagentPermission,
                value: { valueKind: "permission_effect", selector: "plan", effect: "interactive" },
            }),
        ).toBe(false);
        expect(
            selector("subagent_turn_limit").validateSelector({
                ...subagentTurnLimit,
                value: { valueKind: "positive_limit", limit: 0 },
            }),
        ).toBe(false);
        expect(
            selector("subagent_color").validateSelector({
                ...subagentColor,
                value: { valueKind: "selector", selector: "ultraviolet" },
            }),
        ).toBe(false);
        expect(
            selector("subagent_tool").validateSelector({ ...subagentTool, value: { valueKind: "positive_limit", limit: 1 } }),
        ).toBe(false);
        expect(
            selector("subagent_tool").validateSelector({
                ...subagentTool,
                value: { valueKind: "selector", selector: "Bash(git status)" },
            }),
        ).toBe(false);
        expect(selector("subagent_tool").validateSelector({ ...subagentTool, kind: "Skill" })).toBe(false);
    });
});
