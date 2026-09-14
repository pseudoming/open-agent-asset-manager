/** Current native source assessment preserves mapped policy and distinguishes concrete metadata loss. */
import { describe, expect, it } from "vitest";
import { cursorProvider } from "../src/cursor-provider";
import { parseCursorFrontmatter } from "../src/cursor-frontmatter";
import { CURSOR_SKILL_SOURCE_DIALECTS } from "../src/cursor-skill-conversion-assessment";
import {
    canonicalFiles,
    analysisFixture,
    canonicalMaterializationFixture,
    materializationInput,
} from "./cursor-skill-target-test-fixtures";

function fixtureFor(
    header: string = "",
    dialect = "cursor-skill-directory-v1",
    losses: ["runtime_specific_metadata_lost"] | [] = [],
) {
    const variant = "project_folder";
    const native = analysisFixture(variant, "current_exact", canonicalFiles(variant)).dialectInputs[0]!.inputs[0]!;
    if (native.inputKind !== "native_representation") throw new Error("native source missing");
    native.representation.dialectId = dialect;
    const entry = native.files.find((f) => f.relativePath.endsWith("/SKILL.md"))!;
    if (entry.contentKind !== "text") throw new Error("native text missing");
    entry.text = entry.text.replace("disable-model-invocation: true\n", header);
    const fixture = canonicalMaterializationFixture(variant, losses);
    const canonical = fixture.deployment.assets[0]!.version.canonical;
    if (canonical.kind !== "Skill") throw new Error("Skill missing");
    canonical.typeData.invocation.model = { mode: "model_decision" };
    const token = fixture.dialectInputs[0]!.inputs[0]!;
    if (token.inputKind !== "canonical_materialization") throw new Error("canonical token missing");
    if (dialect === "antigravity-skill-flat-v1") {
        entry.relativePath = ".agents/skills/portable-review.md";
        native.files = [entry];
    }
    token.nativePreservationSeed = { representation: native.representation, files: native.files };
    return { fixture, token, entry, canonical };
}
describe("Cursor current source Skill conversion assessment", () => {
    it.each(CURSOR_SKILL_SOURCE_DIALECTS)("preserves fully mapped source fields from %s", async (dialect) => {
        const { fixture } = fixtureFor("", dialect);
        const analysis = await cursorProvider.analyzeRender(fixture);
        expect(analysis.status).toBe("complete");
        expect(
            analysis.semanticOptions.every(
                (o) => o.outcome === "preserved" && o.approvalRequirement.approvalState === "not_required",
            ),
        ).toBe(true);
        const result = await cursorProvider.materializeRender(materializationInput(fixture, "project_folder"));
        expect(result.materializationState).toBe("materialized");
    });
    it.each([
        ["license: MIT\n", "cursor-skill-directory-v1"],
        ["compatibility: Local docs\n", "cursor-skill-directory-v1"],
        ["metadata:\n  owner: source-only\n", "cursor-skill-directory-v1"],
        ["version: release-2\n", "claudecode-skill-directory-v1"],
    ])("discloses only the source metadata loss in %s", async (header, dialect) => {
        const { fixture } = fixtureFor(header, dialect, ["runtime_specific_metadata_lost"]);
        const result = await cursorProvider.analyzeRender(fixture);
        expect(result.status).toBe("complete");
        expect(result.semanticOptions.length).toBeGreaterThan(0);
        for (const option of result.semanticOptions) {
            expect(option.outcome).toBe("degraded");
            if (option.outcome === "degraded") expect(option.degradationKinds).toEqual(["runtime_specific_metadata_lost"]);
            expect(option.approvalRequirement.approvalState).toBe("required");
        }
        expect(
            (await cursorProvider.materializeRender(materializationInput(fixture, "project_folder"))).materializationState,
        ).toBe("materialized");
    });
    it("assesses an owning directory entry when a nested resource is also named SKILL.md", async () => {
        const { fixture, token, entry } = fixtureFor();
        token.nativePreservationSeed!.files.push({
            ...entry,
            relativePath: entry.relativePath.replace(/SKILL.md$/u, "resources/SKILL.md"),
            text: "A bundled example, not the owning entry.",
        });
        expect((await cursorProvider.analyzeRender(fixture)).status).toBe("complete");
    });
    it.each(["extra_file", "wrong_extension"] as const)("rejects an invalid flat source: %s", async (fault) => {
        const { fixture } = fixtureFor("", "antigravity-skill-flat-v1");
        const request = materializationInput(fixture, "project_folder");
        for (const input of [fixture, request]) {
            const token = input.dialectInputs[0]!.inputs[0]!;
            if (token.inputKind !== "canonical_materialization") throw new Error("canonical token missing");
            const seed = token.nativePreservationSeed!,
                entry = seed.files[0]!;
            if (fault === "extra_file") seed.files.push({ ...entry, relativePath: ".agents/skills/extra.md" });
            else entry.relativePath = ".agents/skills/portable-review.txt";
        }
        expect((await cursorProvider.analyzeRender(fixture)).status).toBe("failed");
        expect((await cursorProvider.materializeRender(request)).materializationState).toBe("blocked");
    });
    it("retains expressible metadata and disabled model invocation", async () => {
        const { fixture, canonical } = fixtureFor("metadata:\n  owner: writer\ndisable-model-invocation: true\n");
        canonical.typeData.portableMetadata.metadata = { owner: "writer" };
        canonical.typeData.invocation.model = { mode: "disabled" };
        const result = await cursorProvider.materializeRender(materializationInput(fixture, "project_folder"));
        expect(result.materializationState).toBe("materialized");
        if (result.materializationState !== "materialized") throw new Error("materialization missing");
        const entry = result.materializedUnits[0]!.files.find((f) => f.relativePath.endsWith("/SKILL.md"))!;
        if (entry.content.contentKind !== "text") throw new Error("entry missing");
        expect(parseCursorFrontmatter(entry.content.text).values).toMatchObject({
            metadata: { owner: "writer" },
            "disable-model-invocation": true,
        });
    });
    it.each([
        "unknown-dialect",
        "duplicate-entry",
        "binary-entry",
        "unclosed-header",
        "bad-yaml",
        "unknown-policy",
        "changed-name",
        "changed-body",
    ])("refuses %s without replacing the immutable source", async (fault) => {
        const { fixture } = fixtureFor();
        const request = materializationInput(fixture, "project_folder");
        for (const input of [fixture, request]) {
            const selected = input.dialectInputs[0]!.inputs[0]!;
            if (selected.inputKind !== "canonical_materialization") throw new Error("token missing");
            const seed = selected.nativePreservationSeed!;
            const source = seed.files.find((f) => f.relativePath.endsWith("/SKILL.md"))!;
            if (source.contentKind !== "text") throw new Error("source missing");
            if (fault === "unknown-dialect") seed.representation.dialectId = "unknown-v1";
            else if (fault === "duplicate-entry") seed.files.push({ ...source, relativePath: "other/SKILL.md" });
            else if (fault === "binary-entry")
                seed.files[seed.files.indexOf(source)] = { ...source, contentKind: "binary", bytes: Uint8Array.of(1) };
            else if (fault === "unclosed-header") source.text = "---\nname: broken\n";
            else if (fault === "bad-yaml") source.text = source.text.replace("---\n", "---\nname: duplicate\n");
            else if (fault === "unknown-policy") source.text = source.text.replace("---\n", "---\nfuture-deny: Bash\n");
            else if (fault === "changed-name") source.text = source.text.replace(/name: [^\n]+/, "name: changed-name");
            else source.text += "Unexpected body change.\n";
        }
        const before = structuredClone(fixture),
            requestBefore = structuredClone(request);
        expect((await cursorProvider.analyzeRender(fixture)).status).toBe("failed");
        expect((await cursorProvider.materializeRender(request)).materializationState).toBe("blocked");
        expect(fixture).toEqual(before);
        expect(request).toEqual(requestBefore);
    });
});
