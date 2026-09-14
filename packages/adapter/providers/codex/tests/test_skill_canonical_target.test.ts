/** Real reviewed foreign Skill conversion through the current Codex Provider. */
import { defineDialectComponentV1, sha256SourceBytes } from "@oaam/adapter-framework";
import type { RenderAnalysisInput } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { assertCanonicalEntryControls } from "../../../../../tests/conformance/canonical-entry-test-controls";
import { codexProvider } from "../src/codex-provider";
import { parseCodexFrontmatter } from "../src/codex-frontmatter";
import {
    analysisFixture,
    canonicalFiles,
    materializationInput,
    supportFor,
    textFile,
    type SkillVariant,
} from "./codex-skill-target-test-fixtures";

const VARIANTS = ["project_cli", "project_app", "global_cli", "global_app"] as const;
function fixtureFor(variant: SkillVariant): RenderAnalysisInput {
    // A new foreign source fixture has no Codex-only configuration; native fixtures retain theirs.
    const files = canonicalFiles().filter((file) => file.file.logicalPath !== "agents/openai.yaml");
    const fixture = analysisFixture(variant, "current_exact", files);
    const canonical = fixture.deployment.assets[0]!.version.canonical;
    if (canonical.kind !== "Skill") throw new Error("Skill fixture missing");
    canonical.typeData.entryDialectId = "opencode-skill-markdown-v2";
    canonical.typeData.invocation.model = { mode: "model_decision" };
    canonical.typeData.portableMetadata = {
        license: "MIT",
        compatibility: "Local documentation",
        metadata: { owner: "ordinary-user", revision: "2", "review.context": 'quotes " and line\nbreaks' },
    };
    fixture.deployment.assets[0]!.version.files.find((file) => file.file.logicalPath === "scripts/marker.py")!.file.executable =
        true;
    const sourceRoot = ".opencode/skills/" + canonical.typeData.name;
    const sourceHeader = [
        "---",
        "name: " + JSON.stringify(canonical.typeData.name),
        "description: " + JSON.stringify(canonical.typeData.description),
        "license: MIT",
        "compatibility: Local documentation",
        "metadata:",
        "  owner: ordinary-user",
        '  revision: "2"',
        '  review.context: "quotes \\" and line\\nbreaks"',
        "---",
        "",
    ].join("\n");
    const nativeFiles = fixture.deployment.assets[0]!.version.files.map((file) => {
        const common = {
            relativePath: (sourceRoot + "/" + file.file.logicalPath) as typeof file.file.logicalPath,
            mediaType: file.file.mediaType,
            executable: file.file.executable,
        };
        if (file.contentKind === "text") {
            const text = (file.file.role === "entry" ? sourceHeader : "") + file.text;
            const bytes = new TextEncoder().encode(text);
            return {
                ...common,
                contentKind: "text" as const,
                text,
                bytes: undefined,
                byteSize: bytes.byteLength,
                contentHash: sha256SourceBytes(bytes),
            };
        }
        const bytes = new Uint8Array(file.bytes);
        return {
            ...common,
            contentKind: "binary" as const,
            bytes,
            text: undefined,
            byteSize: bytes.byteLength,
            contentHash: sha256SourceBytes(bytes),
        };
    });
    const nativePreservationSeed = {
        representation: {
            schemaVersion: 1 as const,
            dialectId: "opencode-skill-directory-v2",
            dialectContractFingerprint: fixture.deployment.assets[0]!.version.versionFingerprint,
            canonicalContentFingerprint: fixture.deployment.assets[0]!.version.versionCanonicalContentFingerprint,
            representationFingerprint: fixture.deployment.assets[0]!.version.versionFingerprint,
            files: nativeFiles.map(({ text: _text, bytes: _bytes, ...descriptor }) => descriptor),
        },
        files: nativeFiles,
    };
    fixture.dialectInputs[0]!.inputs = [
        {
            inputKind: "canonical_materialization",
            nativeDialectId: "codex-skill-directory-v1",
            materializer: defineDialectComponentV1(
                `codex.${variant.startsWith("global") ? "global" : "project"}-skill-canonical-graph-v2`,
            ),
            degradationKinds: [],
            nativePreservationSeed,
            reasonCode: "codex_skill_reviewed_canonical_conversion",
            logicalDirectoryPaths: ["assets", "empty", "empty/nested", "scripts"],
        },
    ];
    return fixture;
}
describe("Codex reviewed canonical Skill conversion", () => {
    it.each(VARIANTS)("converts a rich foreign graph for %s with independent entry and resource checks", async (variant) => {
        const fixture = fixtureFor(variant),
            before = structuredClone(fixture);
        const analysis = await codexProvider.analyzeRender(fixture);
        expect(analysis.status, JSON.stringify(analysis)).toBe("complete");
        expect(analysis.semanticOptions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    outcome: "preserved",
                    approvalRequirement: expect.objectContaining({ approvalState: "not_required" }),
                }),
            ]),
        );
        expect(
            analysis.semanticOptions.every(
                (option) => option.outcome === "preserved" && option.approvalRequirement.approvalState === "not_required",
            ),
        ).toBe(true);
        const request = materializationInput(fixture, supportFor(variant));
        const result = await codexProvider.materializeRender(request);
        assertCanonicalEntryControls(codexProvider, request, result);
        if (result.materializationState !== "materialized") throw new Error("Skill conversion blocked");
        const output = result.materializedUnits[0]!;
        const entry = output.files.find((file) => file.relativePath.endsWith("/SKILL.md"))!;
        if (entry.content.contentKind !== "text") throw new Error("text entry missing");
        const canonical = fixture.deployment.assets[0]!.version.canonical;
        if (canonical.kind !== "Skill") throw new Error("Skill missing");
        const parsed = parseCodexFrontmatter(entry.content.text);
        expect(parsed.diagnostics).toEqual([]);
        expect(parsed.values).toEqual({
            name: canonical.typeData.name,
            description: canonical.typeData.description,
            license: "MIT",
            compatibility: "Local documentation",
            metadata: canonical.typeData.portableMetadata.metadata,
        });
        const frontmatter = entry.content.text.slice(4, entry.content.text.indexOf("\n---", 4));
        for (const version of ["1.1", "1.2"] as const) {
            const independent = parseDocument(frontmatter, { version, uniqueKeys: true });
            expect(independent.errors).toEqual([]);
            expect(independent.toJS()).toEqual(parsed.values);
        }
        expect(output.files).toHaveLength(fixture.deployment.assets[0]!.version.files.length);
        for (const source of fixture.deployment.assets[0]!.version.files.filter((file) => file.file.role !== "entry")) {
            const target = output.files.find((file) => file.relativePath.endsWith("/" + source.file.logicalPath))!;
            expect(target.executable).toBe(source.file.executable);
            expect(target.content).toEqual(
                source.contentKind === "text"
                    ? { contentKind: "text", text: source.text }
                    : { contentKind: "binary", bytes: source.bytes },
            );
        }
        expect(analysis.outputUnits[0]!.managedDirectoryBoundaries[0]).toMatchObject({
            schemaVersion: 2,
            desiredDirectoryPaths: expect.arrayContaining([expect.stringMatching(/\/empty\/nested$/)]),
        });
        expect(fixture).toEqual(before);
    });
    it.each([
        "agents/openai.yaml",
        "agents/OPENAI.yaml",
        "agents/openai.yaml/child.txt",
    ])("refuses foreign behavior-bearing resource %s without modifying it", async (logicalPath) => {
        const fixture = fixtureFor("project_cli");
        const resource = textFile(
            logicalPath,
            "policy:\n  allow_implicit_invocation: false\n",
            "99999999-9999-4999-8999-999999999999",
            "resource",
            false,
        );
        fixture.deployment.assets[0]!.version.files.push(resource);
        const before = structuredClone(fixture);
        expect((await codexProvider.analyzeRender(fixture)).status).toBe("failed");
        expect(fixture).toEqual(before);
    });
    it.each(VARIANTS)("materializes canonical-only user content for %s without inventing metadata loss", async (variant) => {
        const fixture = fixtureFor(variant);
        const token = fixture.dialectInputs[0]!.inputs[0]!;
        if (token.inputKind !== "canonical_materialization") throw new Error("canonical token missing");
        delete token.nativePreservationSeed;
        delete token.logicalDirectoryPaths;
        const analysis = await codexProvider.analyzeRender(fixture);
        expect(analysis.status).toBe("complete");
        expect(
            analysis.semanticOptions.every(
                (option) => option.outcome === "preserved" && option.approvalRequirement.approvalState === "not_required",
            ),
        ).toBe(true);
        const request = materializationInput(fixture, supportFor(variant));
        const result = await codexProvider.materializeRender(request);
        assertCanonicalEntryControls(codexProvider, request, result);
        expect(result.materializationState).toBe("materialized");
    });
    it.each([
        "unknown-dialect",
        "duplicate-entry",
        "unclosed-header",
        "unknown-behavior",
        "changed-name",
        "changed-body",
    ])("refuses %s source evidence at analysis and materialization", async (fault) => {
        const fixture = fixtureFor("project_cli");
        const request = materializationInput(fixture, supportFor("project_cli"));
        for (const input of [fixture, request]) {
            const token = input.dialectInputs[0]!.inputs[0]!;
            if (token.inputKind !== "canonical_materialization") throw new Error("canonical token missing");
            const seed = token.nativePreservationSeed!;
            const entry = seed.files.find((file) => file.relativePath.endsWith("/SKILL.md"))!;
            if (entry.contentKind !== "text") throw new Error("source entry missing");
            if (fault === "unknown-dialect") seed.representation.dialectId = "unknown-skill-directory-v1";
            else if (fault === "duplicate-entry")
                seed.files.push({
                    ...entry,
                    relativePath: "another-skill/SKILL.md",
                });
            else if (fault === "unclosed-header") entry.text = "---\nname: incomplete\n";
            else if (fault === "unknown-behavior") entry.text = entry.text.replace("---\n", "---\nfuture-deny: Bash\n");
            else if (fault === "changed-name") entry.text = entry.text.replace(/name: [^\n]+/, "name: changed-name");
            else entry.text += "\nChanged without canonical authority.";
        }
        const before = structuredClone(fixture),
            requestBefore = structuredClone(request);
        expect((await codexProvider.analyzeRender(fixture)).status).toBe("failed");
        expect((await codexProvider.materializeRender(request)).materializationState).toBe("blocked");
        expect(fixture).toEqual(before);
        expect(request).toEqual(requestBefore);
    });
    it.each([
        "01",
        "Null",
        "TRUE",
        ".nan",
        "off",
        "__proto__",
        "key:colon",
    ])("refuses metadata key %j without silently reinterpreting it", async (key) => {
        const fixture = fixtureFor("project_cli");
        const canonical = fixture.deployment.assets[0]!.version.canonical;
        if (canonical.kind !== "Skill") throw new Error("Skill missing");
        canonical.typeData.portableMetadata.metadata = Object.fromEntries([[key, "retained"]]);
        const before = structuredClone(fixture);
        expect((await codexProvider.analyzeRender(fixture)).status).toBe("failed");
        expect(fixture).toEqual(before);
    });
    it("keeps an unrepresentable invocation policy blocked without falling through to default model invocation", async () => {
        const fixture = fixtureFor("project_cli");
        const canonical = fixture.deployment.assets[0]!.version.canonical;
        if (canonical.kind !== "Skill") throw new Error("Skill missing");
        canonical.typeData.invocation.model = { mode: "disabled" };
        expect((await codexProvider.analyzeRender(fixture)).status).toBe("failed");
    });
});
