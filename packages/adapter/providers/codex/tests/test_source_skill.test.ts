import { describe, expect, it } from "vitest";
import { readAccessFailed } from "../../../test-support";
import { codexProvider } from "../src/codex-provider";
import {
    externalRoot,
    projectRoot,
    rawReadInput,
    readSkill,
    skillCapability,
    skillCapabilityForRuntime,
    skillRoot,
    userSelectedReadInput,
} from "./codex-source-test-fixtures";

const VALID_ENTRY = `---\nname: demo\ndescription: Demonstrate the Codex Skill reader.\nlicense: MIT\ncompatibility: Codex\nmetadata:\n  owner: user\n---\n\nRead [the guide](references/guide.md).\n`;

describe("Codex Skill source read", () => {
    it("binds project and current-build family Skill reads to App", async () => {
        const root = projectRoot();
        const capability = skillCapabilityForRuntime(root, "CODEX_APP");
        const result = await codexProvider.read(
            rawReadInput(root, [capability], { ".agents/skills/demo/SKILL.md": VALID_ENTRY }),
        );

        expect(capability).toMatchObject({ agentRuntimeId: "CODEX_APP", entrySupportStatus: "supported" });
        expect(result.candidates).toEqual([expect.objectContaining({ kind: "Skill", scope: "project" })]);
        expect(
            codexProvider.assetSourceCapabilities.find(
                (row) => row.agentRuntimeId === "CODEX_APP" && row.assetKind === "Skill" && row.sourceDomain === "family_shared",
            ),
        ).toMatchObject({ entrySupportStatus: "supported", readPolicy: "auto_read", evidenceLevel: "source_code" });
    });

    it("imports one complete project Skill directory graph with binary resources and resolved references", async () => {
        const result = await readSkill(projectRoot(), {
            ".agents/skills/demo/SKILL.md": VALID_ENTRY,
            ".agents/skills/demo/references/guide.md": "Guide\n",
            ".agents/skills/demo/assets/logo.bin": new Uint8Array([0xff, 0x00, 0x80]),
            ".agents/skills/demo/scripts/run.py": { text: "print('ok')\n", executable: true },
            ".agents/other.txt": "Ignored\n",
        });
        expect(result.candidates).toHaveLength(1);
        const candidate = result.candidates[0];
        expect(candidate).toEqual(
            expect.objectContaining({
                kind: "Skill",
                displayName: "demo",
                displayDescription: "Demonstrate the Codex Skill reader.",
                scope: "project",
                scopePath: "",
                status: "complete",
                assetCandidateStatus: "importable",
                typeData: expect.objectContaining({
                    schemaVersion: 2,
                    name: "demo",
                    description: "Demonstrate the Codex Skill reader.",
                    whenToUse: "",
                    entryDialectId: "codex-skill-markdown-v1",
                    portableMetadata: { license: "MIT", compatibility: "Codex", metadata: { owner: "user" } },
                    invocation: expect.objectContaining({
                        user: { mode: "direct", commandName: "demo" },
                        model: { mode: "model_decision" },
                    }),
                }),
                nativeRepresentation: expect.objectContaining({
                    representationSource: "separate_file_graph",
                    dialectId: "codex-skill-directory-v1",
                }),
            }),
        );
        expect(candidate?.files.map((file) => [file.logicalPath, file.role, file.contentKind, file.executable])).toEqual([
            ["SKILL.md", "entry", "text", false],
            ["assets/logo.bin", "resource", "binary", false],
            ["references/guide.md", "resource", "text", false],
            ["scripts/run.py", "resource", "text", true],
        ]);
        expect(candidate?.files[0]?.references).toEqual([
            expect.objectContaining({ resolution: "resolved_version_file", targetLogicalPath: "references/guide.md" }),
        ]);
        expect(candidate?.nativeRepresentation).toEqual(
            expect.objectContaining({
                files: expect.arrayContaining([
                    expect.objectContaining({ relativePath: ".agents/skills/demo/SKILL.md" }),
                    expect.objectContaining({ relativePath: ".agents/skills/demo/assets/logo.bin" }),
                ]),
            }),
        );
        expect(candidate?.sourceContainerEntryIds.length).toBeGreaterThanOrEqual(4);
    });

    it("maps agents/openai.yaml implicit policy and keeps that file inside the native and canonical graph", async () => {
        const result = await readSkill(skillRoot(), {
            "demo/SKILL.md": VALID_ENTRY,
            "demo/agents/openai.yaml": "interface:\n  display_name: Demo\npolicy:\n  allow_implicit_invocation: false\n",
        });
        const candidate = result.candidates[0];
        expect(candidate?.kind).toBe("Skill");
        if (candidate?.kind !== "Skill") throw new Error("missing Codex Skill fixture");
        expect(candidate.typeData.invocation.model).toEqual({ mode: "disabled" });
        expect(candidate.files.map((file) => file.logicalPath)).toEqual(["SKILL.md", "agents/openai.yaml"]);
        expect(candidate.metadataSourceOrigins.filter((origin) => origin.metadataSubject === "type_data")).toHaveLength(2);
        expect(candidate.nativeRepresentation).toEqual(
            expect.objectContaining({
                files: expect.arrayContaining([expect.objectContaining({ relativePath: "demo/agents/openai.yaml" })]),
            }),
        );
    });

    it("keeps multiple direct Skills separate and excludes system or nested declarations", async () => {
        const result = await readSkill(skillRoot(), {
            "alpha/SKILL.md": VALID_ENTRY.replace("name: demo", "name: alpha"),
            "alpha/references/SKILL.md": VALID_ENTRY.replace("name: demo", "name: nested"),
            "beta/SKILL.md": VALID_ENTRY.replace("name: demo", "name: beta"),
            ".system/builtin/SKILL.md": VALID_ENTRY.replace("name: demo", "name: builtin"),
        });
        expect(result.candidates.map((candidate) => candidate.displayName)).toEqual(["alpha", "beta"]);
        expect(result.candidates[0]?.files.map((file) => file.logicalPath)).toContain("references/SKILL.md");
        expect(result.sourceParseReports[0]?.readEntryDispositions).toEqual(
            expect.arrayContaining([expect.objectContaining({ disposition: "ignored", reasonCode: "outside_source_pattern" })]),
        );
    });

    it("keeps same-name Skills separate because Codex exposes both selectors", async () => {
        const result = await readSkill(skillRoot(), {
            "first/SKILL.md": VALID_ENTRY.replace("Demonstrate the Codex Skill reader.", "First declaration."),
            "second/SKILL.md": VALID_ENTRY.replace("Demonstrate the Codex Skill reader.", "Second declaration."),
        });
        expect(result.candidates).toHaveLength(2);
        expect(result.candidates.map((candidate) => candidate.displayName)).toEqual(["demo", "demo"]);
        expect(new Set(result.candidates.map((candidate) => candidate.candidateId)).size).toBe(2);
        expect(result.sourceParseReports[0]).toMatchObject({ status: "parsed" });
    });

    it("rejects sources missing the required frontmatter contract and executable authority fields", async () => {
        const invalidEntries = [
            "No frontmatter\n",
            "---\nname: demo\ndescription: missing close\n",
            "---\ndescription: Missing name\n---\nBody\n",
            "---\nname: demo\n---\nBody\n",
            "---\nname: demo\ndescription: Empty body\n---\n \n",
            "---\nname: demo\ndescription: Hooked\nhooks: active\n---\nBody\n",
            "---\nname: demo\ndescription: Shelled\nshell: bash\n---\nBody\n",
        ];
        for (const entry of invalidEntries) {
            const result = await readSkill(skillRoot(), { "demo/SKILL.md": entry, "demo/resource.txt": "resource" });
            expect(result.candidates, entry).toEqual([]);
            expect(result.sourceParseReports[0]?.status, entry).toBe("skipped_ignored_source");
        }
        const binary = await readSkill(skillRoot(), { "demo/SKILL.md": new Uint8Array([0xff, 0xfe]) });
        expect(binary.candidates).toEqual([]);
        expect(binary.diagnostics).toContainEqual(expect.objectContaining({ code: "codex.skill_entry_not_utf8" }));
    });

    it("preserves known Codex-only metadata while keeping truly unknown semantics incomplete", async () => {
        const nativeOnly = await readSkill(skillRoot(), {
            "demo/SKILL.md": VALID_ENTRY,
            "demo/agents/openai.yaml":
                "interface:\n  default_prompt: Use this context\ndependencies:\n  tools:\n    - type: mcp\n      value: docs\n",
        });
        expect(nativeOnly.candidates).toEqual([
            expect.objectContaining({
                kind: "Skill",
                status: "complete",
                assetCandidateStatus: "importable",
                files: expect.arrayContaining([expect.objectContaining({ logicalPath: "agents/openai.yaml" })]),
                nativeRepresentation: expect.objectContaining({
                    files: expect.arrayContaining([expect.objectContaining({ relativePath: "demo/agents/openai.yaml" })]),
                }),
                diagnostics: [
                    expect.objectContaining({
                        code: "codex.skill_openai_yaml_native_only",
                        severity: "warning",
                    }),
                    expect.objectContaining({
                        code: "codex.skill_openai_yaml_native_only",
                        severity: "warning",
                    }),
                ],
            }),
        ]);

        const cases = [
            {
                files: { "demo/SKILL.md": VALID_ENTRY.replace("license: MIT", "future-field: active") },
                code: "codex.skill_frontmatter_semantics_unsupported",
            },
            {
                files: { "demo/SKILL.md": VALID_ENTRY, "demo/agents/openai.yaml": "policy: [\n" },
                code: "codex.skill_openai_yaml_invalid",
            },
            {
                files: { "demo/SKILL.md": VALID_ENTRY.replace("metadata:\n  owner: user", "metadata:\n  - invalid") },
                code: "codex.skill_metadata_invalid",
            },
        ];
        for (const fixture of cases) {
            const result = await readSkill(skillRoot(), fixture.files);
            expect(result.candidates).toEqual([
                expect.objectContaining({
                    kind: "Skill",
                    status: "incomplete",
                    assetCandidateStatus: "incomplete",
                    diagnostics: expect.arrayContaining([expect.objectContaining({ code: fixture.code, severity: "error" })]),
                }),
            ]);
        }

        const nonUtf8Metadata = await readSkill(skillRoot(), {
            "demo/SKILL.md": VALID_ENTRY,
            "demo/agents/openai.yaml": new Uint8Array([0xff, 0xfe]),
        });
        expect(nonUtf8Metadata.candidates).toEqual([
            expect.objectContaining({
                status: "incomplete",
                diagnostics: expect.arrayContaining([
                    expect.objectContaining({ code: "codex.skill_openai_yaml_not_utf8", severity: "error" }),
                ]),
            }),
        ]);

        const root = skillRoot();
        const input = rawReadInput(root, [skillCapability(root)], {
            "demo/SKILL.md": VALID_ENTRY,
            "demo/references/unreadable.md": "Unreadable\n",
            "hidden/SKILL.md": VALID_ENTRY.replace("name: demo", "name: hidden"),
        });
        const base = input.readAccess;
        const paths = new Map<string, string>();
        input.readAccess = {
            ...base,
            async resolveRootEntry(obligationId, sourceRootId) {
                const outcome = await base.resolveRootEntry(obligationId, sourceRootId);
                if (outcome.state === "succeeded") paths.set(outcome.value.readEntryHandleId, outcome.value.relativePath);
                return outcome;
            },
            async listDirectory(handleId) {
                const outcome = await base.listDirectory(handleId);
                if (outcome.state === "succeeded") {
                    for (const child of outcome.value.children) paths.set(child.readEntryHandleId, child.relativePath);
                }
                return outcome;
            },
            async readFile(handleId) {
                return paths.get(handleId) === "demo/references/unreadable.md" || paths.get(handleId) === "hidden/SKILL.md"
                    ? readAccessFailed("fixture-unreadable", "permission_denied")
                    : base.readFile(handleId);
            },
        };
        const unreadable = await codexProvider.read(input);
        expect(unreadable.candidates).toEqual([
            expect.objectContaining({
                status: "incomplete",
                diagnostics: expect.arrayContaining([expect.objectContaining({ code: "codex.skill_resource_unreadable" })]),
            }),
        ]);
        expect(unreadable.diagnostics).toContainEqual(expect.objectContaining({ code: "codex.skill_entry_unreadable" }));
    });

    it("honors explicit global versus project binding without widening the selected root", async () => {
        const root = externalRoot();
        const capability = skillCapability(root);
        const global = await codexProvider.read(
            userSelectedReadInput(root, capability, "global", "", { "demo/SKILL.md": VALID_ENTRY }),
        );
        expect(global.candidates).toEqual([expect.objectContaining({ kind: "Skill", scope: "global", scopePath: "" })]);

        const project = await codexProvider.read(
            userSelectedReadInput(root, capability, "project", "/fixture/external", {
                ".agents/skills/demo/SKILL.md": VALID_ENTRY,
                "demo/SKILL.md": VALID_ENTRY,
            }),
        );
        expect(project.candidates).toEqual([expect.objectContaining({ kind: "Skill", scope: "project", scopePath: "" })]);
    });
});
