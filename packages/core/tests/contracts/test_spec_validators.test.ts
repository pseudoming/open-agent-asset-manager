import { describe, expect, it } from "vitest";
import type { SkillTypeDataV2, SubagentTypeDataV2, WorkflowTypeDataV2 } from "../../src/contracts/specs";
import {
    isAssetKindTypeDataV2,
    isGuidanceTypeDataV1,
    isMemoryTypeDataV2,
    isRuleTypeDataV2,
    isSkillTypeDataV2,
    isSubagentTypeDataV2,
    isWorkflowTypeDataV2,
    parseSubagentInstructionEntryV1,
} from "../../src/specs/validators";
import type { StrictSchema } from "../../src/foundation/strict-schema";
import { validateStrict } from "../../src/foundation/strict-schema";

const UUID = "00000000-0000-4000-8000-000000000001";

function clone<T>(value: T): T {
    return structuredClone(value);
}

function workflow(): WorkflowTypeDataV2 {
    return {
        schemaVersion: 2,
        name: "review",
        description: "Review changes",
        implementation: {
            kind: "instructions",
            instructionDialectId: "claudecode-command-markdown-v1",
            execution: {
                mode: "caller",
                agent: { mode: "agent_runtime_default" },
                model: { mode: "inherit" },
                effort: { mode: "inherit" },
                shell: { mode: "none" },
            },
            toolPolicy: {
                preapproved: [],
                denied: [],
                otherwise: "inherit_agent_runtime_policy",
            },
        },
        invocation: {
            commandNames: ["review"],
            userInvocable: true,
            agentInvocable: false,
            argumentHint: "[path]",
            argumentNames: ["path"],
        },
    };
}

function skill(): SkillTypeDataV2 {
    return {
        schemaVersion: 2,
        name: "lint",
        description: "Run the project linter",
        whenToUse: "Before commit",
        entryDialectId: "agent-skills-markdown-v1",
        portableMetadata: {
            license: "MIT",
            compatibility: "node",
            metadata: { owner: "oaam" },
        },
        invocation: {
            pathCondition: { mode: "none" },
            user: { mode: "not_directly_invocable" },
            model: { mode: "model_decision" },
            argumentHint: "",
            argumentNames: [],
        },
        toolPolicy: {
            preapproved: [],
            denied: [],
            otherwise: "inherit_agent_runtime_policy",
        },
        execution: {
            mode: "caller",
            model: { mode: "inherit" },
            effort: { mode: "inherit" },
        },
    };
}

function subagent(): SubagentTypeDataV2 {
    return {
        schemaVersion: 2,
        name: "reviewer",
        description: "Reviews changes",
        promptContextPolicy: { mode: "agent_runtime_default" },
        tools: {
            availability: { base: { mode: "inherit_available" }, unavailable: [] },
            permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
        },
        dependencies: { preloadedSkillVersionIds: [] },
        memory: { mode: "disabled" },
        execution: {
            permission: { mode: "inherit" },
            workspaceIsolation: { mode: "agent_runtime_default" },
            scheduling: { mode: "agent_runtime_default" },
            turnLimit: { mode: "agent_runtime_default" },
            model: { mode: "inherit" },
            effort: { mode: "inherit" },
            sampling: {
                temperature: { mode: "agent_runtime_default" },
                topP: { mode: "agent_runtime_default" },
            },
        },
        directInvocation: { mode: "delegated_only" },
        presentation: {
            listing: "agent_runtime_default",
            color: { mode: "agent_runtime_default" },
        },
    };
}

describe("strict schema runner", () => {
    it("covers scalar constraints without coercion", () => {
        expect(validateStrict({ kind: "string" }, "")).toBe(true);
        expect(validateStrict({ kind: "string" }, 1)).toBe(false);
        expect(validateStrict({ kind: "string", nonBlank: true }, " ")).toBe(false);
        expect(validateStrict({ kind: "string", allowed: ["a"] }, "b")).toBe(false);
        expect(validateStrict({ kind: "string", allowed: ["a"] }, "a")).toBe(true);

        expect(validateStrict({ kind: "number" }, 0.5)).toBe(true);
        expect(validateStrict({ kind: "number" }, "0")).toBe(false);
        expect(validateStrict({ kind: "number" }, Number.NaN)).toBe(false);
        expect(validateStrict({ kind: "number", integer: true }, 0.5)).toBe(false);
        expect(validateStrict({ kind: "number", min: 1 }, 0)).toBe(false);
        expect(validateStrict({ kind: "number", max: 1 }, 2)).toBe(false);
        expect(validateStrict({ kind: "number", integer: true, min: 1, max: 2 }, 2)).toBe(true);

        expect(validateStrict({ kind: "boolean" }, false)).toBe(true);
        expect(validateStrict({ kind: "boolean" }, 0)).toBe(false);
        expect(validateStrict({ kind: "literal", value: "x" }, "x")).toBe(true);
        expect(validateStrict({ kind: "literal", value: "x" }, "y")).toBe(false);
    });

    it("covers arrays, records, objects, unions and custom predicates", () => {
        const stringSchema: StrictSchema = { kind: "string" };
        expect(validateStrict({ kind: "array", element: stringSchema }, "x")).toBe(false);
        expect(validateStrict({ kind: "array", element: stringSchema, minLength: 1 }, [])).toBe(false);
        expect(validateStrict({ kind: "array", element: stringSchema }, [1])).toBe(false);
        expect(validateStrict({ kind: "array", element: stringSchema }, ["a"])).toBe(true);
        expect(validateStrict({ kind: "array", element: stringSchema, uniqueBy: String }, ["a", "a"])).toBe(false);
        expect(validateStrict({ kind: "array", element: stringSchema, uniqueBy: String }, ["a", "b"])).toBe(true);

        expect(validateStrict({ kind: "record", value: stringSchema }, [])).toBe(false);
        expect(validateStrict({ kind: "record", value: stringSchema }, { a: 1 })).toBe(false);
        expect(validateStrict({ kind: "record", value: stringSchema }, { a: "b" })).toBe(true);

        const objectSchema: StrictSchema = {
            kind: "object",
            fields: { a: stringSchema, b: { kind: "boolean" } },
        };
        expect(validateStrict(objectSchema, null)).toBe(false);
        expect(validateStrict(objectSchema, { a: "x" })).toBe(false);
        expect(validateStrict(objectSchema, { a: "x", c: false })).toBe(false);
        expect(validateStrict(objectSchema, { a: 1, b: false })).toBe(false);
        expect(validateStrict(objectSchema, { a: "x", b: false })).toBe(true);

        const unionSchema: StrictSchema = {
            kind: "union",
            variants: [
                { kind: "literal", value: "a" },
                { kind: "literal", value: "b" },
            ],
        };
        expect(validateStrict(unionSchema, "b")).toBe(true);
        expect(validateStrict(unionSchema, "c")).toBe(false);
        expect(validateStrict({ kind: "custom", check: (value) => value === 3 }, 3)).toBe(true);
        expect(validateStrict({ kind: "custom", check: (value) => value === 3 }, 4)).toBe(false);
    });
});

describe("six strict canonical typeData validators", () => {
    it("accepts Guidance and all Rule activation branches", () => {
        expect(isGuidanceTypeDataV1({ schemaVersion: 1 })).toBe(true);
        expect(isGuidanceTypeDataV1({ schemaVersion: 1, extra: true })).toBe(false);

        for (const activation of [
            { mode: "always" },
            { mode: "manual" },
            { mode: "path", globs: ["src/**/*.ts"] },
            { mode: "model_decision" },
        ]) {
            expect(
                isRuleTypeDataV2({
                    schemaVersion: 2,
                    name: "rule",
                    description: "Use this rule",
                    activation,
                }),
            ).toBe(true);
        }
    });

    it("rejects ambiguous or malformed Rule contracts", () => {
        expect(
            isRuleTypeDataV2({
                schemaVersion: 2,
                name: "rule",
                description: "",
                activation: { mode: "model_decision" },
            }),
        ).toBe(false);
        expect(
            isRuleTypeDataV2({
                schemaVersion: 2,
                name: "rule",
                description: "x",
                activation: { mode: "path", globs: ["src/**", "src/**"] },
            }),
        ).toBe(false);
        expect(isRuleTypeDataV2({ schemaVersion: 2 })).toBe(false);
    });

    it("accepts Workflow instruction selections and executable dialect", () => {
        const base = workflow();
        expect(isWorkflowTypeDataV2(base)).toBe(true);

        const selected = clone(base);
        if (selected.implementation.kind !== "instructions") throw new Error("fixture");
        selected.implementation.execution = {
            mode: "isolated",
            agent: { mode: "agent_runtime_named", selector: "reviewer" },
            model: { mode: "selected", dialectId: "claude", selector: "haiku", relativeTier: 2 },
            effort: { mode: "selected", dialectId: "codex", selector: "high", relativeTier: 8 },
            shell: { mode: "selected", dialectId: "posix", selector: "bash" },
        };
        selected.implementation.instructionDialectId = "antigravity-workflow-markdown-v1";
        expect(isWorkflowTypeDataV2(selected)).toBe(true);

        const bound = clone(base);
        if (bound.implementation.kind !== "instructions") throw new Error("fixture");
        bound.implementation.execution.agent = { mode: "bound", targetAssetVersionId: UUID };
        bound.implementation.execution.shell = { mode: "agent_runtime_default" };
        bound.implementation.instructionDialectId = "opencode-command-markdown-v1";
        expect(isWorkflowTypeDataV2(bound)).toBe(true);

        const executable = clone(base);
        executable.implementation = {
            kind: "executable",
            executableDialectId: "future-runtime-executable-v1",
        };
        expect(isWorkflowTypeDataV2(executable)).toBe(true);
        executable.implementation.executableDialectId = " ";
        expect(isWorkflowTypeDataV2(executable)).toBe(false);
    });

    it("rejects overlapping Workflow tool authority and loose objects", () => {
        const value = workflow();
        if (value.implementation.kind !== "instructions") throw new Error("fixture");
        const selector = { dialectId: "claude", selector: "Read" };
        value.implementation.toolPolicy.preapproved = [selector];
        value.implementation.toolPolicy.denied = [selector];
        expect(isWorkflowTypeDataV2(value)).toBe(false);
        expect(isWorkflowTypeDataV2({ ...workflow(), extra: true })).toBe(false);
    });

    it("accepts Skill invocation and execution variants", () => {
        expect(isSkillTypeDataV2(skill())).toBe(true);
        const value = skill();
        value.entryDialectId = "future-runtime-skill-entry-v1";
        value.invocation = {
            pathCondition: { mode: "required", patterns: ["src/**/*.ts"] },
            user: { mode: "direct", commandName: "lint" },
            model: { mode: "disabled" },
            argumentHint: "[path]",
            argumentNames: ["path"],
        };
        expect(isSkillTypeDataV2(value)).toBe(true);
        value.entryDialectId = "";
        expect(isSkillTypeDataV2(value)).toBe(false);
        value.entryDialectId = "future-runtime-skill-entry-v1";
        value.execution = {
            mode: "isolated",
            agent: { mode: "agent_runtime_named", dialectId: "claude", selector: "reviewer" },
            model: { mode: "selected", dialectId: "claude", selector: "haiku", relativeTier: -1 },
            effort: { mode: "selected", dialectId: "codex", selector: "high", relativeTier: 9 },
        };
        expect(isSkillTypeDataV2(value)).toBe(true);

        value.execution.agent = { mode: "bound", targetAssetVersionId: UUID };
        expect(isSkillTypeDataV2(value)).toBe(true);
        value.execution.agent = { mode: "agent_runtime_default" };
        expect(isSkillTypeDataV2(value)).toBe(true);
    });

    it("rejects unsafe Skill patterns, duplicate arguments and authority overlap", () => {
        for (const pattern of ["", "a\0b", "a\\b", "/abs", "a//b", "a/./b", "a/../b"]) {
            const value = skill();
            value.invocation.pathCondition = { mode: "required", patterns: [pattern] };
            expect(isSkillTypeDataV2(value), pattern).toBe(false);
        }
        const duplicate = skill();
        duplicate.invocation.argumentNames = ["x", "x"];
        expect(isSkillTypeDataV2(duplicate)).toBe(false);
        const overlap = skill();
        const selector = { dialectId: "claude", selector: "Bash" };
        overlap.toolPolicy.preapproved = [selector];
        overlap.toolPolicy.denied = [selector];
        expect(isSkillTypeDataV2(overlap)).toBe(false);
    });

    it("accepts Subagent variants without erasing runtime dialect data", () => {
        expect(isSubagentTypeDataV2(subagent())).toBe(true);
        const value = subagent();
        value.promptContextPolicy = {
            mode: "selected",
            dialectId: "claude",
            selectors: ["project", "user"],
        };
        value.tools.availability.base = {
            mode: "allowlist",
            allowed: [
                {
                    mode: "agent_runtime_tool",
                    selector: { dialectId: "claude", selector: "Read" },
                },
                { mode: "bound_subagent", targetAssetVersionId: UUID },
            ],
        };
        value.tools.availability.unavailable = [
            {
                mode: "agent_runtime_tool",
                selector: { dialectId: "claude", selector: "Bash" },
            },
        ];
        value.tools.permission.rules = [
            {
                selector: {
                    mode: "agent_runtime_tool",
                    selector: { dialectId: "claude", selector: "Read" },
                },
                action: "preapproved",
            },
            {
                selector: { mode: "bound_subagent", targetAssetVersionId: UUID },
                action: "ask",
            },
        ];
        value.dependencies.preloadedSkillVersionIds = [UUID];
        value.memory = { mode: "persistent", storageScope: "project_local" };
        value.execution = {
            permission: {
                mode: "selected",
                dialectId: "claude",
                selector: "plan",
                effect: "read_only",
            },
            workspaceIsolation: { mode: "isolated_worktree" },
            scheduling: { mode: "always_background" },
            turnLimit: { mode: "bounded", dialectId: "claude", limit: 3 },
            model: { mode: "selected", dialectId: "claude", selector: "haiku", relativeTier: 2 },
            effort: { mode: "selected", dialectId: "codex", selector: "high", relativeTier: 8 },
            sampling: {
                temperature: { mode: "selected", value: 0.2 },
                topP: { mode: "selected", value: 0.9 },
            },
        };
        value.directInvocation = {
            mode: "user_selectable",
            initialPrompt: { mode: "resource", logicalPath: "prompts/start.md", dialectId: "md" },
        };
        value.presentation = {
            listing: "visible",
            color: { mode: "selected", dialectId: "claude", selector: "blue" },
        };
        expect(isSubagentTypeDataV2(value)).toBe(true);

        value.memory = { mode: "persistent", storageScope: "global" };
        value.execution.scheduling = { mode: "always_foreground" };
        value.directInvocation = { mode: "agent_runtime_default" };
        value.presentation.listing = "hidden";
        expect(isSubagentTypeDataV2(value)).toBe(true);
        value.memory = { mode: "persistent", storageScope: "project_shared" };
        value.tools.availability.base = { mode: "none" };
        value.directInvocation = { mode: "user_selectable", initialPrompt: { mode: "none" } };
        expect(isSubagentTypeDataV2(value)).toBe(true);
    });

    it("rejects duplicate and malformed Subagent authorities", () => {
        const duplicate = subagent();
        const selector = {
            mode: "agent_runtime_tool" as const,
            selector: { dialectId: "claude", selector: "Read" },
        };
        duplicate.tools.availability.unavailable = [selector, selector];
        expect(isSubagentTypeDataV2(duplicate)).toBe(false);

        const badLimit = subagent();
        badLimit.execution.turnLimit = { mode: "bounded", dialectId: "claude", limit: 0 };
        expect(isSubagentTypeDataV2(badLimit)).toBe(false);
        expect(isSubagentTypeDataV2({ ...subagent(), name: "" })).toBe(false);
    });

    it("accepts Memory Unit and Catalog, but rejects duplicate or malformed members", () => {
        expect(
            isMemoryTypeDataV2({
                schemaVersion: 2,
                entityRole: "unit",
                card: { name: "topic", description: "" },
                loading: { card: "high", body: "low" },
                applicabilityRule: "",
            }),
        ).toBe(true);
        expect(
            isMemoryTypeDataV2({
                schemaVersion: 2,
                entityRole: "catalog",
                members: [{ targetAssetVersionId: UUID, routingTitle: "Topic", routingHint: "" }],
            }),
        ).toBe(true);
        expect(
            isMemoryTypeDataV2({
                schemaVersion: 2,
                entityRole: "catalog",
                members: [
                    { targetAssetVersionId: UUID, routingTitle: "A", routingHint: "" },
                    { targetAssetVersionId: UUID, routingTitle: "B", routingHint: "" },
                ],
            }),
        ).toBe(false);
        expect(isMemoryTypeDataV2({ schemaVersion: 2, entityRole: "unknown" })).toBe(false);
    });

    it("validates the exact kind/typeData pair instead of kind alone", () => {
        const pairs = [
            { kind: "Guidance", typeData: { schemaVersion: 1 } },
            {
                kind: "Rule",
                typeData: {
                    schemaVersion: 2,
                    name: "rule",
                    description: "x",
                    activation: { mode: "always" },
                },
            },
            { kind: "Workflow", typeData: workflow() },
            { kind: "Skill", typeData: skill() },
            { kind: "Subagent", typeData: subagent() },
            {
                kind: "Memory",
                typeData: {
                    schemaVersion: 2,
                    entityRole: "catalog",
                    members: [],
                },
            },
        ];
        for (const pair of pairs) expect(isAssetKindTypeDataV2(pair)).toBe(true);
        expect(isAssetKindTypeDataV2(null)).toBe(false);
        expect(isAssetKindTypeDataV2({ kind: "Unknown", typeData: {} })).toBe(false);
        expect(isAssetKindTypeDataV2({ kind: "Skill", typeData: workflow() })).toBe(false);
    });
});

describe("Subagent canonical instruction entry", () => {
    it("parses the exact section structure", () => {
        expect(
            parseSubagentInstructionEntryV1(
                JSON.stringify({
                    schemaVersion: 1,
                    sections: [{ title: "Role", content: "Review code" }],
                }),
            ),
        ).toEqual({
            schemaVersion: 1,
            sections: [{ title: "Role", content: "Review code" }],
        });
    });

    it("rejects invalid JSON, empty sections, blank content and extra fields", () => {
        expect(parseSubagentInstructionEntryV1("{")).toBeNull();
        expect(parseSubagentInstructionEntryV1('{"schemaVersion":1,"sections":[]}')).toBeNull();
        expect(parseSubagentInstructionEntryV1('{"schemaVersion":1,"sections":[{"title":"Role","content":" "}]}')).toBeNull();
        expect(
            parseSubagentInstructionEntryV1('{"schemaVersion":1,"sections":[{"title":"Role","content":"x","extra":1}]}'),
        ).toBeNull();
    });
});
