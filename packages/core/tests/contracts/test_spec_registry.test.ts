import { describe, expect, it } from "vitest";
import type { AssetVersionFileContentV2, FileReferenceV2 } from "../../src/contracts/asset-version";
import type { AssetKindTypeDataV2, SubagentTypeDataV2 } from "../../src/contracts/specs";
import type { AssetKind, UuidV4 } from "../../src/contracts/primitives";
import {
    BUILTIN_ASSET_KINDS,
    createAssetSpecRegistryForTest,
    getAssetSpecHandler,
    listAssetSpecHandlers,
    validateAssetSpecVersionGraph,
    type AssetSpecHandler,
    type AssetSpecVersionNode,
} from "../../src/specs/registry";

const SHA = `sha256:${"a".repeat(64)}` as const;

function id(sequence: number): UuidV4 {
    return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function textFile(
    logicalPath: string,
    role: "entry" | "resource" | "dependency" = "entry",
    text = "content",
    references: FileReferenceV2[] = [],
): AssetVersionFileContentV2 {
    return {
        file: {
            fileId: id(900 + logicalPath.length),
            logicalPath,
            role,
            contentHash: SHA,
            contentKind: "text",
            mediaType: "text/markdown",
            byteSize: Buffer.byteLength(text),
            executable: false,
            references,
        },
        contentKind: "text",
        text,
    };
}

function binaryFile(logicalPath: string): AssetVersionFileContentV2 {
    return {
        file: {
            fileId: id(990),
            logicalPath,
            role: "entry",
            contentHash: SHA,
            contentKind: "binary",
            mediaType: "application/octet-stream",
            byteSize: 1,
            executable: false,
            references: [],
        },
        contentKind: "binary",
        bytes: Uint8Array.of(1),
    };
}

function workflowCanonical(boundVersionId?: UuidV4): AssetKindTypeDataV2 {
    return {
        kind: "Workflow",
        typeData: {
            schemaVersion: 2,
            name: "review",
            description: "Review",
            implementation: {
                kind: "instructions",
                instructionDialectId: "claudecode-command-markdown-v1",
                execution: {
                    mode: "caller",
                    agent:
                        boundVersionId === undefined
                            ? { mode: "agent_runtime_default" }
                            : { mode: "bound", targetAssetVersionId: boundVersionId },
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
                agentInvocable: true,
                argumentHint: "[path]",
                argumentNames: ["path"],
            },
        },
    };
}

function skillCanonical(boundVersionId?: UuidV4): AssetKindTypeDataV2 {
    return {
        kind: "Skill",
        typeData: {
            schemaVersion: 2,
            name: "lint",
            description: "Lint",
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
            execution:
                boundVersionId === undefined
                    ? { mode: "caller", model: { mode: "inherit" }, effort: { mode: "inherit" } }
                    : {
                          mode: "isolated",
                          agent: { mode: "bound", targetAssetVersionId: boundVersionId },
                          model: { mode: "inherit" },
                          effort: { mode: "inherit" },
                      },
        },
    };
}

function subagentTypeData(): SubagentTypeDataV2 {
    return {
        schemaVersion: 2,
        name: "reviewer",
        description: "Review",
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

function subagentCanonical(): AssetKindTypeDataV2 {
    return { kind: "Subagent", typeData: subagentTypeData() };
}

function memoryUnitCanonical(name = "topic"): AssetKindTypeDataV2 {
    return {
        kind: "Memory",
        typeData: {
            schemaVersion: 2,
            entityRole: "unit",
            card: { name, description: "A memory topic" },
            loading: { card: "high", body: "low" },
            applicabilityRule: "when relevant",
        },
    };
}

function memoryCatalogCanonical(memberIds: UuidV4[]): AssetKindTypeDataV2 {
    return {
        kind: "Memory",
        typeData: {
            schemaVersion: 2,
            entityRole: "catalog",
            members: memberIds.map((targetAssetVersionId, index) => ({
                targetAssetVersionId,
                routingTitle: `Topic ${index}`,
                routingHint: "hint",
            })),
        },
    };
}

function node(
    versionId: UuidV4,
    canonical: AssetKindTypeDataV2 | unknown,
    files: AssetVersionFileContentV2[],
    overrides: Partial<AssetSpecVersionNode> = {},
): AssetSpecVersionNode {
    return {
        versionId,
        scope: "project",
        projectId: id(800),
        scopePath: "",
        status: "complete",
        canonical,
        files,
        ...overrides,
    };
}

function subagentEntry(): AssetVersionFileContentV2 {
    return textFile(
        "agent.json",
        "entry",
        JSON.stringify({
            schemaVersion: 1,
            sections: [{ title: "Role", content: "Review changes" }],
        }),
    );
}

function validNodes(): AssetSpecVersionNode[] {
    const memoryUnitId = id(6);
    return [
        node(id(1), { kind: "Guidance", typeData: { schemaVersion: 1 } }, [textFile("GUIDE.md")]),
        node(
            id(2),
            {
                kind: "Rule",
                typeData: {
                    schemaVersion: 2,
                    name: "rule",
                    description: "Rule description",
                    activation: { mode: "path", globs: ["src/**"] },
                },
            },
            [textFile("rule.md")],
        ),
        node(id(3), workflowCanonical(), [textFile("workflow.md")]),
        node(id(4), skillCanonical(), [textFile("SKILL.md")]),
        node(id(5), subagentCanonical(), [subagentEntry()]),
        node(memoryUnitId, memoryUnitCanonical(), [textFile("topic.md")]),
        node(id(7), memoryCatalogCanonical([memoryUnitId]), []),
    ];
}

function issueCodes(nodes: AssetSpecVersionNode[]): string[] {
    return validateAssetSpecVersionGraph(nodes).issues.map((issue) => issue.code);
}

describe("AssetSpec registry construction", () => {
    it("contains exactly one frozen handler for each approved kind", () => {
        const handlers = listAssetSpecHandlers();
        expect(handlers.map((handler) => handler.kind)).toEqual(BUILTIN_ASSET_KINDS);
        expect(Object.isFrozen(handlers)).toBe(true);
        expect(handlers.every(Object.isFrozen)).toBe(true);
        for (const kind of BUILTIN_ASSET_KINDS) expect(getAssetSpecHandler(kind).kind).toBe(kind);
    });

    it("rejects missing, duplicate, foreign and post-construction mutation", () => {
        const handlers = listAssetSpecHandlers();
        expect(() => createAssetSpecRegistryForTest(handlers.slice(1))).toThrow("missing AssetSpec handler: Guidance");
        expect(() => createAssetSpecRegistryForTest([...handlers, handlers[0]])).toThrow("duplicate AssetSpec handler: Guidance");
        const foreign = {
            ...handlers[0],
            kind: "Foreign",
        } as unknown as AssetSpecHandler;
        expect(() => createAssetSpecRegistryForTest([...handlers, foreign])).toThrow("foreign kind");
        const registry = createAssetSpecRegistryForTest(handlers);
        expect(() => registry.get("Foreign" as AssetKind)).toThrow("unknown AssetKind");
        expect(() => (registry.list() as AssetSpecHandler[]).push(handlers[0])).toThrow();
    });
});

describe("AssetSpec complete version and file graph", () => {
    it("accepts all six kinds including Memory Unit and zero-entry Catalog", () => {
        expect(validateAssetSpecVersionGraph(validNodes())).toEqual({ valid: true, issues: [] });
    });

    it("reports duplicate nodes, invalid kinds and strict typeData mismatches", () => {
        const good = validNodes()[0];
        expect(issueCodes([good, clone(good)])).toContain("duplicate_version");
        expect(issueCodes([node(id(20), { kind: "Unknown", typeData: {} }, [])])).toContain("invalid_kind");
        expect(issueCodes([node(id(21), { kind: "Skill", typeData: { schemaVersion: 1 } }, [])])).toContain("invalid_type_data");
    });

    it("enforces complete entry rules without applying them to incomplete Versions", () => {
        expect(issueCodes([node(id(22), { kind: "Guidance", typeData: { schemaVersion: 1 } }, [])])).toContain("invalid_entry");
        expect(issueCodes([node(id(23), { kind: "Guidance", typeData: { schemaVersion: 1 } }, [binaryFile("x.bin")])])).toContain(
            "invalid_entry",
        );
        expect(
            issueCodes([node(id(24), { kind: "Guidance", typeData: { schemaVersion: 1 } }, [textFile("x.md", "entry", " ")])]),
        ).toContain("invalid_entry");
        expect(issueCodes([node(id(25), memoryCatalogCanonical([]), [textFile("index.md")])])).toContain("unexpected_entry");
        expect(
            validateAssetSpecVersionGraph([
                node(id(26), { kind: "Guidance", typeData: { schemaVersion: 1 } }, [], {
                    status: "incomplete",
                }),
            ]).valid,
        ).toBe(true);
    });

    it("rejects duplicate logical paths and content-kind contradictions", () => {
        const duplicate = textFile("same.md");
        expect(
            issueCodes([
                node(id(27), { kind: "Guidance", typeData: { schemaVersion: 1 } }, [
                    duplicate,
                    { ...clone(duplicate), file: { ...clone(duplicate.file), fileId: id(999) } },
                ]),
            ]),
        ).toContain("duplicate_logical_path");

        const mismatch = textFile("x.md");
        mismatch.file.contentKind = "binary";
        expect(issueCodes([node(id(28), { kind: "Guidance", typeData: { schemaVersion: 1 } }, [mismatch])])).toContain(
            "content_kind_mismatch",
        );
    });

    it("validates resolved local references and all required unresolved states", () => {
        const missing: FileReferenceV2 = {
            kind: "include",
            rawTarget: "missing.md",
            required: false,
            diagnostics: [],
            resolution: "resolved_version_file",
            targetLogicalPath: "missing.md",
        };
        expect(
            issueCodes([
                node(id(29), { kind: "Guidance", typeData: { schemaVersion: 1 } }, [
                    textFile("entry.md", "entry", "x", [missing]),
                ]),
            ]),
        ).toContain("missing_version_file");

        for (const resolution of ["unresolved", "external", "forbidden"] as const) {
            const reference: FileReferenceV2 = {
                kind: "link",
                rawTarget: "x",
                required: true,
                diagnostics: [],
                resolution,
            };
            expect(
                issueCodes([
                    node(id(30), { kind: "Guidance", typeData: { schemaVersion: 1 } }, [
                        textFile("entry.md", "entry", "x", [reference]),
                    ]),
                ]),
            ).toContain("required_reference_unresolved");
        }

        const optional: FileReferenceV2 = {
            kind: "link",
            rawTarget: "x",
            required: false,
            diagnostics: [],
            resolution: "unresolved",
        };
        const local: FileReferenceV2 = {
            kind: "include",
            rawTarget: "resource.md",
            required: true,
            diagnostics: [],
            resolution: "resolved_version_file",
            targetLogicalPath: "resource.md",
        };
        expect(
            validateAssetSpecVersionGraph([
                node(id(31), { kind: "Guidance", typeData: { schemaVersion: 1 } }, [
                    textFile("entry.md", "entry", "x", [optional, local]),
                    textFile("resource.md", "resource"),
                ]),
            ]).valid,
        ).toBe(true);
    });
});

describe("AssetSpec dependency graph", () => {
    it("accepts bound Workflow/Skill/Subagent dependencies and resolved asset references", () => {
        const subagentId = id(40);
        const skillId = id(41);
        const subagentData = subagentTypeData();
        subagentData.dependencies.preloadedSkillVersionIds = [skillId];
        subagentData.tools.availability.base = {
            mode: "allowlist",
            allowed: [
                { mode: "bound_subagent", targetAssetVersionId: id(42) },
                {
                    mode: "agent_runtime_tool",
                    selector: { dialectId: "claude", selector: "Read" },
                },
            ],
        };
        subagentData.tools.availability.unavailable = [{ mode: "bound_subagent", targetAssetVersionId: id(43) }];
        subagentData.tools.permission.rules = [
            {
                selector: { mode: "bound_subagent", targetAssetVersionId: id(44) },
                action: "ask",
            },
        ];
        const targets = [id(42), id(43), id(44)].map((versionId) => node(versionId, subagentCanonical(), [subagentEntry()]));
        const crossReference: FileReferenceV2 = {
            kind: "link",
            rawTarget: "asset",
            required: true,
            diagnostics: [],
            resolution: "resolved_asset_version",
            targetAssetVersionId: id(43),
        };
        const nodes = [
            node(subagentId, { kind: "Subagent", typeData: subagentData }, [subagentEntry()]),
            node(skillId, skillCanonical(id(42)), [textFile("SKILL.md", "entry", "x", [crossReference])]),
            node(id(45), workflowCanonical(subagentId), [textFile("workflow.md")]),
            ...targets,
        ];
        expect(validateAssetSpecVersionGraph(nodes).valid).toBe(true);
    });

    it("rejects missing, incomplete, wrong-kind, wrong-role and wrong-scope dependencies", () => {
        expect(issueCodes([node(id(50), workflowCanonical(id(51)), [textFile("w.md")])])).toContain("missing_dependency");
        expect(
            issueCodes([
                node(id(52), workflowCanonical(id(53)), [textFile("w.md")]),
                node(id(53), subagentCanonical(), [subagentEntry()], { status: "incomplete" }),
            ]),
        ).toContain("wrong_dependency_kind");
        expect(
            issueCodes([
                node(id(54), workflowCanonical(id(55)), [textFile("w.md")]),
                node(id(55), skillCanonical(), [textFile("SKILL.md")]),
            ]),
        ).toContain("wrong_dependency_kind");

        const unitId = id(56);
        expect(
            issueCodes([node(id(57), memoryCatalogCanonical([unitId]), []), node(unitId, memoryCatalogCanonical([]), [])]),
        ).toContain("wrong_dependency_kind");
        expect(
            issueCodes([
                node(id(58), memoryCatalogCanonical([unitId]), []),
                node(unitId, memoryUnitCanonical(), [textFile("topic.md")], {
                    scopePath: "other",
                }),
            ]),
        ).toContain("wrong_dependency_scope");
    });

    it("rejects cycles while accepting shared already-visited leaves", () => {
        const leftData = subagentTypeData();
        const rightData = subagentTypeData();
        leftData.tools.availability.base = {
            mode: "allowlist",
            allowed: [{ mode: "bound_subagent", targetAssetVersionId: id(61) }],
        };
        rightData.tools.availability.base = {
            mode: "allowlist",
            allowed: [{ mode: "bound_subagent", targetAssetVersionId: id(60) }],
        };
        expect(
            issueCodes([
                node(id(60), { kind: "Subagent", typeData: leftData }, [subagentEntry()]),
                node(id(61), { kind: "Subagent", typeData: rightData }, [subagentEntry()]),
            ]),
        ).toContain("dependency_cycle");

        const target = node(id(62), subagentCanonical(), [subagentEntry()]);
        expect(
            validateAssetSpecVersionGraph([
                target,
                node(id(63), workflowCanonical(id(62)), [textFile("one.md")]),
                node(id(64), workflowCanonical(id(62)), [textFile("two.md")]),
            ]).valid,
        ).toBe(true);
    });
});

describe("Subagent resource and search projection semantics", () => {
    it("requires a real non-executable text resource for user-selectable initial prompt", () => {
        const canonical = subagentCanonical();
        if (canonical.kind !== "Subagent") throw new Error("fixture");
        canonical.typeData.directInvocation = {
            mode: "user_selectable",
            initialPrompt: { mode: "resource", logicalPath: "prompts/start.md", dialectId: "md" },
        };
        const validFiles = [subagentEntry(), textFile("prompts/start.md", "resource", "Start here")];
        expect(validateAssetSpecVersionGraph([node(id(70), canonical, validFiles)]).valid).toBe(true);

        for (const files of [
            [subagentEntry()],
            [subagentEntry(), textFile("prompts/start.md", "entry", "Start")],
            [subagentEntry(), textFile("prompts/start.md", "resource", " ")],
        ]) {
            expect(issueCodes([node(id(71), canonical, files)])).toContain("invalid_initial_prompt_resource");
        }
        const executable = textFile("prompts/start.md", "resource", "Start");
        executable.file.executable = true;
        expect(issueCodes([node(id(72), canonical, [subagentEntry(), executable])])).toContain("invalid_initial_prompt_resource");
        const binary = binaryFile("prompts/start.md");
        binary.file.role = "resource";
        expect(issueCodes([node(id(73), canonical, [subagentEntry(), binary])])).toContain("invalid_initial_prompt_resource");
    });

    it("produces kind-owned search projections without reading runtime state", () => {
        const nodes = validNodes();
        const projections = nodes.map((item) => {
            const canonical = item.canonical as AssetKindTypeDataV2;
            return getAssetSpecHandler(canonical.kind).searchProjection(canonical, item.files);
        });
        expect(projections[0]).toEqual([]);
        expect(projections[1]).toContain("src/**");
        expect(projections[2]).toContain("review");
        expect(projections[3]).toContain("oaam");
        expect(projections[4]).toContain("Review changes");
        expect(projections[5]).toContain("when relevant");
        expect(projections[6]).toContain("Topic 0");

        const manualRule: AssetKindTypeDataV2 = {
            kind: "Rule",
            typeData: {
                schemaVersion: 2,
                name: "manual",
                description: "Manual rule",
                activation: { mode: "manual" },
            },
        };
        expect(getAssetSpecHandler("Rule").searchProjection(manualRule, [])).toEqual(["manual", "Manual rule"]);
        expect(getAssetSpecHandler("Subagent").searchProjection(subagentCanonical(), [])).toEqual(["reviewer", "Review"]);
    });
});
