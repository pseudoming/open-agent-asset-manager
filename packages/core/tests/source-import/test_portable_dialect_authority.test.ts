import { describe, expect, it } from "vitest";
import {
    assertPortableDialectContractRefs,
    resolvePortableDialectContractRefs,
} from "../../src/catalog/portable-dialect-authority";
import { createVersionDialectRegistry, type VersionDialectRegistryV1 } from "../../src/catalog/version-dialect-registry";
import type {
    AssetKindTypeDataV2,
    PortableEntryDialectFieldV1,
    PortableSelectorDialectFieldV1,
    PortableSelectorDialectUseV1,
    Sha256Digest,
} from "../../src/types";
import { makePortableEntryDialectContract, makePortableSelectorDialectContract } from "./fixtures/dialect-contracts";
import { makeBinaryFile, makeTextFile } from "../catalog/fixtures/version-v2";

const ENTRY_DIALECTS: ReadonlyArray<readonly ["Workflow" | "Skill" | "Subagent", PortableEntryDialectFieldV1, string]> = [
    ["Workflow", "workflow_instruction", "workflow-entry-v1"],
    ["Workflow", "workflow_executable", "workflow-executable-v1"],
    ["Skill", "skill_entry", "skill-entry-v1"],
    ["Subagent", "subagent_initial_prompt", "subagent-prompt-v1"],
];

const SELECTOR_DIALECTS: ReadonlyArray<readonly ["Workflow" | "Skill" | "Subagent", PortableSelectorDialectFieldV1, string]> = [
    ["Workflow", "workflow_tool", "workflow-tool-v1"],
    ["Workflow", "workflow_model", "workflow-model-v1"],
    ["Workflow", "workflow_effort", "workflow-effort-v1"],
    ["Workflow", "workflow_shell", "workflow-shell-v1"],
    ["Skill", "skill_tool", "skill-tool-v1"],
    ["Skill", "skill_agent", "skill-agent-v1"],
    ["Skill", "skill_model", "skill-model-v1"],
    ["Skill", "skill_effort", "skill-effort-v1"],
    ["Subagent", "subagent_context", "subagent-context-v1"],
    ["Subagent", "subagent_tool", "subagent-tool-v1"],
    ["Subagent", "subagent_permission", "subagent-permission-v1"],
    ["Subagent", "subagent_model", "subagent-model-v1"],
    ["Subagent", "subagent_effort", "subagent-effort-v1"],
    ["Subagent", "subagent_turn_limit", "subagent-limit-v1"],
    ["Subagent", "subagent_color", "subagent-color-v1"],
];

describe("portable dialect Version authority", () => {
    it("collects every Workflow, Skill, and Subagent portable field into sorted refs", () => {
        const registry = completeRegistry();
        expect(
            resolvePortableDialectContractRefs(
                { kind: "Guidance", typeData: { schemaVersion: 1 } },
                [makeTextFile()],
                "complete",
                registry,
            ),
        ).toEqual([]);

        const workflowRefs = resolvePortableDialectContractRefs(
            workflowInstructions(),
            [makeTextFile("Review.\n", "workflow.md")],
            "complete",
            registry,
        );
        expect(workflowRefs.map((ref) => ref.field)).toEqual([
            "workflow_effort",
            "workflow_instruction",
            "workflow_model",
            "workflow_shell",
            "workflow_tool",
        ]);
        expect(
            resolvePortableDialectContractRefs(
                workflowExecutable(),
                [
                    {
                        ...makeBinaryFile(new Uint8Array([1]), "workflow.js"),
                        file: {
                            ...makeBinaryFile(new Uint8Array([1]), "workflow.js").file,
                            role: "entry",
                        },
                    },
                ],
                "complete",
                registry,
            ).map((ref) => ref.field),
        ).toEqual(["workflow_executable"]);

        const skillRefs = resolvePortableDialectContractRefs(
            skill("named"),
            [makeTextFile("Use it.\n", "SKILL.md")],
            "complete",
            registry,
        );
        expect(skillRefs.map((ref) => ref.field)).toEqual([
            "skill_agent",
            "skill_effort",
            "skill_entry",
            "skill_model",
            "skill_tool",
        ]);
        expect(
            resolvePortableDialectContractRefs(
                skill("caller"),
                [makeTextFile("Use it.\n", "SKILL.md")],
                "complete",
                registry,
            ).map((ref) => ref.field),
        ).toEqual(["skill_entry"]);
        expect(
            resolvePortableDialectContractRefs(
                skill("runtime_default"),
                [makeTextFile("Use it.\n", "SKILL.md")],
                "complete",
                registry,
            ).map((ref) => ref.field),
        ).toEqual(["skill_entry"]);

        const subagentFiles = [
            makeTextFile("Review.\n", "SUBAGENT.md"),
            {
                ...makeTextFile("Start here.\n", "initial-prompt.md"),
                file: {
                    ...makeTextFile("Start here.\n", "initial-prompt.md").file,
                    fileId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                    role: "resource" as const,
                },
            },
        ];
        const subagentRefs = resolvePortableDialectContractRefs(subagent(true), subagentFiles, "complete", registry);
        expect(subagentRefs.map((ref) => ref.field)).toEqual([
            "subagent_color",
            "subagent_context",
            "subagent_effort",
            "subagent_initial_prompt",
            "subagent_model",
            "subagent_permission",
            "subagent_tool",
            "subagent_turn_limit",
        ]);
        expect(
            resolvePortableDialectContractRefs(subagent(false), [makeTextFile("Review.\n", "SUBAGENT.md")], "complete", registry),
        ).toEqual([]);
        expect(() =>
            assertPortableDialectContractRefs({
                canonical: workflowInstructions(),
                canonicalFiles: [makeTextFile("Review.\n", "workflow.md")],
                versionStatus: "complete",
                storedRefs: workflowRefs,
                registry,
            }),
        ).not.toThrow();
    });

    it("fails closed when a selector is missing, rejected, or changes identity mid-resolution", () => {
        const canonical = workflowInstructions();
        const files = [makeTextFile("Review.\n", "workflow.md")];
        expect(() =>
            resolvePortableDialectContractRefs(
                canonical,
                files,
                "complete",
                createVersionDialectRegistry(
                    [],
                    [],
                    ENTRY_DIALECTS.map(([kind, field, dialectId]) => makePortableEntryDialectContract(kind, field, dialectId)),
                    [],
                ),
            ),
        ).toThrow(/portable selector dialect contract rejected/);

        const rejecting = completeRegistry((use) => use.field !== "workflow_model");
        expect(() => resolvePortableDialectContractRefs(canonical, files, "complete", rejecting)).toThrow(/workflow_model/);

        let toolLookup = 0;
        const conflicting: VersionDialectRegistryV1 = {
            getNative: () => null,
            getRestoration: () => null,
            getPortableEntry: completeRegistry().getPortableEntry,
            getPortableSelector(kind, field, dialectId) {
                const resolved = completeRegistry().getPortableSelector(kind, field, dialectId);
                if (resolved === null || field !== "workflow_tool") return resolved;
                toolLookup += 1;
                return {
                    ...resolved,
                    contractFingerprint: `sha256:${String(toolLookup).padStart(64, "0")}` as Sha256Digest,
                };
            },
        };
        expect(() => resolvePortableDialectContractRefs(canonical, files, "complete", conflicting)).toThrow(
            /fingerprint conflict/,
        );
        expect(() =>
            assertPortableDialectContractRefs({
                canonical,
                canonicalFiles: files,
                versionStatus: "complete",
                storedRefs: [],
                registry: completeRegistry(),
            }),
        ).toThrow(/do not match canonical Version semantics/);
    });

    it("rejects a portable contract outside the candidate source runtime or version", () => {
        const canonical = workflowInstructions();
        const files = [makeTextFile("Review.\n", "workflow.md")];
        const registry = completeRegistry(
            () => true,
            (source) => source.agentRuntimeId === "FIXTURE_CLI" && source.versionText === "1.0",
        );
        expect(() =>
            resolvePortableDialectContractRefs(canonical, files, "complete", registry, [
                { agentRuntimeId: "OTHER_CLI", versionText: "1.0" },
            ]),
        ).toThrow(/portable entry dialect contract rejected/);
        expect(() =>
            resolvePortableDialectContractRefs(canonical, files, "complete", registry, [
                { agentRuntimeId: "FIXTURE_CLI", versionText: "2.0" },
            ]),
        ).toThrow(/portable entry dialect contract rejected/);
        expect(
            resolvePortableDialectContractRefs(canonical, files, "complete", registry, [
                { agentRuntimeId: "FIXTURE_CLI", versionText: "1.0" },
            ]),
        ).toHaveLength(5);

        const permissiveCallback = completeRegistry(
            () => true,
            () => true,
        );
        expect(() =>
            resolvePortableDialectContractRefs(canonical, files, "complete", permissiveCallback, [
                { agentRuntimeId: "FOREIGN_CLI", versionText: "1.0" },
            ]),
        ).toThrow(/portable entry dialect contract rejected/);
    });

    it("requires complete Versions to contain their entry while preserving incomplete contract identity", () => {
        const dialectId = "workflow-executable-v1";
        const registry = createVersionDialectRegistry(
            [],
            [],
            [
                makePortableEntryDialectContract(
                    "Workflow",
                    "workflow_executable",
                    dialectId,
                    (input) =>
                        input.versionStatus === "incomplete" ||
                        input.canonicalFiles.some(
                            (file) => file.file.logicalPath === input.use.logicalPath && file.file.role === "entry",
                        ),
                ),
            ],
            [],
        );
        const canonical = workflowExecutable();

        expect(() => resolvePortableDialectContractRefs(canonical, [], "complete", registry)).toThrow(/workflow_executable/);
        expect(resolvePortableDialectContractRefs(canonical, [], "incomplete", registry)).toHaveLength(1);
    });
});

function completeRegistry(
    selectorValidator: (use: PortableSelectorDialectUseV1) => boolean = () => true,
    sourceValidator: (source: { agentRuntimeId: string; versionText: string }) => boolean = () => true,
): VersionDialectRegistryV1 {
    const entries = ENTRY_DIALECTS.map(([kind, field, dialectId]) => makePortableEntryDialectContract(kind, field, dialectId));
    const selectors = SELECTOR_DIALECTS.map(([kind, field, dialectId]) =>
        makePortableSelectorDialectContract(kind, field, dialectId, selectorValidator),
    );
    for (const contract of [...entries, ...selectors]) {
        contract.validateSourceApplicability = sourceValidator;
    }
    return createVersionDialectRegistry([], [], entries, selectors);
}

function workflowInstructions(): AssetKindTypeDataV2 {
    return {
        kind: "Workflow",
        typeData: {
            schemaVersion: 2,
            name: "review",
            description: "Review changes",
            implementation: {
                kind: "instructions",
                instructionDialectId: "workflow-entry-v1",
                execution: {
                    mode: "caller",
                    agent: { mode: "agent_runtime_default" },
                    model: {
                        mode: "selected",
                        dialectId: "workflow-model-v1",
                        selector: "fast",
                        relativeTier: 1,
                    },
                    effort: {
                        mode: "selected",
                        dialectId: "workflow-effort-v1",
                        selector: "high",
                        relativeTier: 7,
                    },
                    shell: {
                        mode: "selected",
                        dialectId: "workflow-shell-v1",
                        selector: "bash",
                    },
                },
                toolPolicy: {
                    preapproved: [{ dialectId: "workflow-tool-v1", selector: "Read" }],
                    denied: [{ dialectId: "workflow-tool-v1", selector: "Write" }],
                    otherwise: "inherit_agent_runtime_policy",
                },
            },
            invocation: {
                commandNames: ["review"],
                userInvocable: true,
                agentInvocable: false,
                argumentHint: "",
                argumentNames: [],
            },
        },
    };
}

function workflowExecutable(): AssetKindTypeDataV2 {
    return {
        ...workflowInstructions(),
        typeData: {
            ...workflowInstructions().typeData,
            implementation: {
                kind: "executable",
                executableDialectId: "workflow-executable-v1",
            },
        },
    } as AssetKindTypeDataV2;
}

function skill(mode: "caller" | "runtime_default" | "named"): AssetKindTypeDataV2 {
    const execution =
        mode === "caller"
            ? {
                  mode: "caller" as const,
                  model: { mode: "inherit" as const },
                  effort: { mode: "inherit" as const },
              }
            : {
                  mode: "isolated" as const,
                  agent:
                      mode === "named"
                          ? {
                                mode: "agent_runtime_named" as const,
                                dialectId: "skill-agent-v1",
                                selector: "reviewer",
                            }
                          : { mode: "agent_runtime_default" as const },
                  model:
                      mode === "named"
                          ? {
                                mode: "selected" as const,
                                dialectId: "skill-model-v1",
                                selector: "fast",
                                relativeTier: 1 as const,
                            }
                          : { mode: "inherit" as const },
                  effort:
                      mode === "named"
                          ? {
                                mode: "selected" as const,
                                dialectId: "skill-effort-v1",
                                selector: "high",
                                relativeTier: 7 as const,
                            }
                          : { mode: "inherit" as const },
              };
    return {
        kind: "Skill",
        typeData: {
            schemaVersion: 2,
            name: "sample",
            description: "Sample skill",
            whenToUse: "Use for samples",
            entryDialectId: "skill-entry-v1",
            portableMetadata: { license: "", compatibility: "", metadata: {} },
            invocation: {
                pathCondition: { mode: "none" },
                userInvocation: {
                    commandNames: [],
                    invocability: "agent_runtime_default",
                    argumentHint: "",
                    argumentNames: [],
                },
                modelInvocation: "agent_runtime_default",
            },
            toolPolicy: {
                preapproved: mode === "named" ? [{ dialectId: "skill-tool-v1", selector: "Read" }] : [],
                denied: mode === "named" ? [{ dialectId: "skill-tool-v1", selector: "Write" }] : [],
                otherwise: "inherit_agent_runtime_policy",
            },
            execution,
        },
    };
}

function subagent(selected: boolean): AssetKindTypeDataV2 {
    return {
        kind: "Subagent",
        typeData: {
            schemaVersion: 2,
            name: "reviewer",
            description: "Reviews changes",
            promptContextPolicy: selected
                ? {
                      mode: "selected",
                      dialectId: "subagent-context-v1",
                      selectors: ["project", "user"],
                  }
                : { mode: "agent_runtime_default" },
            tools: {
                availability: {
                    base: selected
                        ? {
                              mode: "allowlist",
                              allowed: [
                                  {
                                      mode: "agent_runtime_tool",
                                      selector: {
                                          dialectId: "subagent-tool-v1",
                                          selector: "Read",
                                      },
                                  },
                                  {
                                      mode: "bound_subagent",
                                      targetAssetVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                                  },
                              ],
                          }
                        : { mode: "inherit_available" },
                    unavailable: selected
                        ? [
                              {
                                  mode: "agent_runtime_tool",
                                  selector: {
                                      dialectId: "subagent-tool-v1",
                                      selector: "Write",
                                  },
                              },
                          ]
                        : [],
                },
                permission: {
                    rules: selected
                        ? [
                              {
                                  selector: {
                                      mode: "agent_runtime_tool",
                                      selector: {
                                          dialectId: "subagent-tool-v1",
                                          selector: "Bash",
                                      },
                                  },
                                  action: "ask",
                              },
                              {
                                  selector: {
                                      mode: "bound_subagent",
                                      targetAssetVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                                  },
                                  action: "denied",
                              },
                          ]
                        : [],
                    otherwise: "inherit_agent_runtime_policy",
                },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission: selected
                    ? {
                          mode: "selected",
                          dialectId: "subagent-permission-v1",
                          selector: "plan",
                          effect: "read_only",
                      }
                    : { mode: "inherit" },
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling: { mode: "agent_runtime_default" },
                turnLimit: selected
                    ? { mode: "bounded", dialectId: "subagent-limit-v1", limit: 3 }
                    : { mode: "agent_runtime_default" },
                model: selected
                    ? {
                          mode: "selected",
                          dialectId: "subagent-model-v1",
                          selector: "fast",
                          relativeTier: 1,
                      }
                    : { mode: "inherit" },
                effort: selected
                    ? {
                          mode: "selected",
                          dialectId: "subagent-effort-v1",
                          selector: "high",
                          relativeTier: 7,
                      }
                    : { mode: "inherit" },
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
            directInvocation: selected
                ? {
                      mode: "user_selectable",
                      initialPrompt: {
                          mode: "resource",
                          logicalPath: "initial-prompt.md",
                          dialectId: "subagent-prompt-v1",
                      },
                  }
                : { mode: "delegated_only" },
            presentation: {
                listing: "agent_runtime_default",
                color: selected
                    ? {
                          mode: "selected",
                          dialectId: "subagent-color-v1",
                          selector: "blue",
                      }
                    : { mode: "agent_runtime_default" },
            },
        },
    };
}
