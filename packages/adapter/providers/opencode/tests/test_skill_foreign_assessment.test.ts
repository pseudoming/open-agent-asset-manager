/** Operation-input boundary controls; actual source readers/imports are exercised by public conformance. */
import { describe, expect, it } from "vitest";
import { opencodeProvider } from "../src/opencode-provider";
import {
    analysisFixture,
    canonicalFiles,
    canonicalMaterializationFixture,
    baseAnalysisFixture,
    supportFor,
    VERSION_ID,
    materializationInput,
} from "./opencode-skill-target-test-fixtures";

function fixtureFor(
    dialect = "claudecode-skill-directory-v1",
    extraHeader = "",
    losses: ["runtime_specific_metadata_lost"] | [] = [],
) {
    let input = canonicalMaterializationFixture("project_folder");
    const native = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder")).dialectInputs[0]!
        .inputs[0]!;
    if (native.inputKind !== "native_representation") throw new Error("native fixture missing");
    native.representation.dialectId = dialect;
    const entry = native.files.find((file) => file.relativePath.endsWith("/SKILL.md"))!;
    if (entry.contentKind !== "text") throw new Error("source entry missing");
    entry.text = entry.text.replace("slash: true\n", extraHeader);
    if (dialect === "antigravity-skill-flat-v1") {
        entry.relativePath = ".agents/skills/review.md";
        native.files = [entry];
        input.deployment.assets[0]!.version.files = input.deployment.assets[0]!.version.files.filter(
            (file) => file.file.role === "entry",
        );
    }
    const token = input.dialectInputs[0]!.inputs[0]!;
    if (token.inputKind !== "canonical_materialization") throw new Error("canonical input missing");
    token.degradationKinds = losses;
    token.nativePreservationSeed = { representation: native.representation, files: native.files };
    if (dialect === "antigravity-skill-flat-v1") {
        input = baseAnalysisFixture(
            "project_folder",
            VERSION_ID,
            input.deployment.assets[0]!.version.files,
            input.dialectInputs[0]!.inputs,
            supportFor("project_folder"),
        );
    }
    return { input, token, entry };
}

describe("OpenCode current foreign Skill source assessment", () => {
    it.each([
        "antigravity-skill-flat-v1",
        "antigravity-skill-folder-v1",
        "claudecode-skill-directory-v1",
        "codex-skill-directory-v1",
        "cursor-skill-directory-v1",
        "opencode-skill-directory-v2",
        "zcode-skill-directory-v1",
    ])("preserves mapped fields at the component boundary for %s", async (dialect) => {
        const { input } = fixtureFor(dialect);
        const analyzed = await opencodeProvider.analyzeRender(input);
        expect(analyzed.status).toBe("complete");
        expect(analyzed.semanticOptions.length).toBeGreaterThan(0);
        for (const option of analyzed.semanticOptions) {
            expect(option.outcome).toBe("preserved");
            expect(option.approvalRequirement.approvalState).toBe("not_required");
        }
        expect(
            (await opencodeProvider.materializeRender(materializationInput(input, "project_folder"))).materializationState,
        ).toBe("materialized");
    });
    it("requires only the disclosed Claude version metadata loss for materialization", async () => {
        const { input } = fixtureFor("claudecode-skill-directory-v1", 'version: "2026-09"\n', ["runtime_specific_metadata_lost"]);
        const analyzed = await opencodeProvider.analyzeRender(input);
        expect(analyzed.status).toBe("complete");
        for (const option of analyzed.semanticOptions) {
            expect(option.outcome).toBe("degraded");
            if (option.outcome === "degraded") expect(option.degradationKinds).toEqual(["runtime_specific_metadata_lost"]);
            expect(option.approvalRequirement.approvalState).toBe("required");
        }
        expect(
            (await opencodeProvider.materializeRender(materializationInput(input, "project_folder"))).materializationState,
        ).toBe("materialized");
    });
    it("does not mistake a nested SKILL.md resource for another owning entry", async () => {
        const { input, token, entry } = fixtureFor();
        token.nativePreservationSeed!.files.push({
            ...entry,
            relativePath: entry.relativePath.replace("/SKILL.md", "/examples/SKILL.md"),
            text: "Bundled example.",
        });
        expect((await opencodeProvider.analyzeRender(input)).status).toBe("complete");
    });
    it.each([
        "unknown_dialect",
        "sibling_entry",
        "binary_entry",
        "unclosed_header",
        "invalid_yaml",
        "unknown_behavior",
        "changed_name",
        "changed_body",
        "flat_extra_file",
        "flat_extension",
    ] as const)("rejects %s before a loss approval can authorize output", async (fault) => {
        const { input } = fixtureFor(fault.startsWith("flat_") ? "antigravity-skill-flat-v1" : "claudecode-skill-directory-v1");
        const request = materializationInput(input, "project_folder");
        for (const value of [input, request]) {
            const token = value.dialectInputs[0]!.inputs[0]!;
            if (token.inputKind !== "canonical_materialization") throw new Error("canonical input missing");
            const seed = token.nativePreservationSeed!,
                entry = seed.files[0]!;
            if (entry.contentKind !== "text") throw new Error("source entry missing");
            if (fault === "unknown_dialect") seed.representation.dialectId = "unassessed-private-skill-v1";
            else if (fault === "sibling_entry") seed.files.push({ ...entry, relativePath: "other/SKILL.md" });
            else if (fault === "binary_entry") seed.files[0] = { ...entry, contentKind: "binary", bytes: Uint8Array.of(1) };
            else if (fault === "unclosed_header") entry.text = "---\nname: open\n";
            else if (fault === "invalid_yaml") entry.text = entry.text.replace("---\n", "---\nname: duplicate\n");
            else if (fault === "unknown_behavior") entry.text = entry.text.replace("---\n", "---\nfuture-deny: Bash\n");
            else if (fault === "changed_name") entry.text = entry.text.replace(/name: [^\n]+/u, "name: another-skill");
            else if (fault === "changed_body") entry.text += "Unreviewed body.";
            else if (fault === "flat_extra_file") seed.files.push({ ...entry, relativePath: ".agents/skills/extra.md" });
            else entry.relativePath = ".agents/skills/review.txt";
        }
        expect((await opencodeProvider.analyzeRender(input)).status).toBe("failed");
        expect((await opencodeProvider.materializeRender(request)).materializationState).toBe("blocked");
    });
});
