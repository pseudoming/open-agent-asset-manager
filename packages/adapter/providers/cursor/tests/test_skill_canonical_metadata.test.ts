/** Foreign metadata remains in source authority; expressible target metadata survives reviewed conversion. */
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { assertCanonicalEntryControls } from "../../../../../tests/conformance/canonical-entry-test-controls";
import { cursorProvider } from "../src/cursor-provider";
import { parseCursorFrontmatter } from "../src/cursor-frontmatter";
import { VARIANTS, canonicalMaterializationFixture, materializationInput } from "./cursor-skill-target-test-fixtures";

describe("Cursor reviewed canonical Skill metadata", () => {
    it.each(VARIANTS)("keeps owner/revision in %s and reviews metadata the target cannot express", async (variant) => {
        const fixture = canonicalMaterializationFixture(variant, ["runtime_specific_metadata_lost"]);
        const canonical = fixture.deployment.assets[0]!.version.canonical;
        if (canonical.kind !== "Skill") throw new Error("Skill missing");
        canonical.typeData.entryDialectId = "opencode-skill-markdown-v2";
        canonical.typeData.portableMetadata = {
            license: "MIT",
            compatibility: "Local documentation only",
            metadata: { owner: "ordinary-user", revision: "2", "review.context": 'quotes " and line\nbreaks' },
        };
        const original = structuredClone(fixture);
        const analysis = await cursorProvider.analyzeRender(fixture);
        expect(analysis.status, JSON.stringify(analysis)).toBe("complete");
        expect(analysis.semanticOptions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    outcome: "degraded",
                    degradationKinds: ["runtime_specific_metadata_lost"],
                    approvalRequirement: expect.objectContaining({ approvalState: "required" }),
                }),
            ]),
        );
        expect(
            analysis.semanticOptions.every(
                (option) =>
                    option.outcome === "degraded" &&
                    JSON.stringify(option.degradationKinds) === JSON.stringify(["runtime_specific_metadata_lost"]),
            ),
        ).toBe(true);
        const request = materializationInput(fixture, variant);
        const result = await cursorProvider.materializeRender(request);
        assertCanonicalEntryControls(cursorProvider, request, result);
        if (result.materializationState !== "materialized") throw new Error("conversion blocked");
        const entry = result.materializedUnits[0]!.files.find((file) => file.relativePath.endsWith("/SKILL.md"))!;
        if (entry.content.contentKind !== "text") throw new Error("entry is not text");
        const parsed = parseCursorFrontmatter(entry.content.text);
        expect(parsed.diagnostics).toEqual([]);
        expect(parsed.values.metadata).toEqual(canonical.typeData.portableMetadata.metadata);
        const frontmatter = entry.content.text.slice(4, entry.content.text.indexOf("\n---", 4));
        for (const version of ["1.1", "1.2"] as const) {
            const independent = parseDocument(frontmatter, { version, uniqueKeys: true });
            expect(independent.errors).toEqual([]);
            expect(independent.toJS().metadata).toEqual(canonical.typeData.portableMetadata.metadata);
        }
        expect(parsed.values).not.toHaveProperty("license");
        expect(parsed.values).not.toHaveProperty("compatibility");
        expect(fixture).toEqual(original);
        expect(result.materializedUnits[0]!.files).toHaveLength(fixture.deployment.assets[0]!.version.files.length);
        for (const source of fixture.deployment.assets[0]!.version.files.filter((file) => file.file.role !== "entry")) {
            const target = result.materializedUnits[0]!.files.find((file) =>
                file.relativePath.endsWith("/" + source.file.logicalPath),
            )!;
            expect(target.executable).toBe(source.file.executable);
            expect(target.content).toEqual(
                source.contentKind === "text"
                    ? { contentKind: "text", text: source.text }
                    : { contentKind: "binary", bytes: source.bytes },
            );
        }
    });

    it.each(["01: a\n  1: b", "Null: a\n  null: b"])("independently reproduces YAML key aliasing for %s", (mapping) => {
        const document = parseDocument("metadata:\n  " + mapping, { version: "1.2", uniqueKeys: true });
        expect(document.errors.map((error) => error.code)).toEqual(["DUPLICATE_KEY"]);
    });
    it.each([
        "key:with:colons",
        "line\nbreak",
        "__proto__",
        "01",
        "1",
        "Null",
        "null",
        "TRUE",
        ".nan",
        "yes",
        "off",
    ])("refuses an unrepresentable bounded metadata key %j before dropping it", async (key) => {
        const fixture = canonicalMaterializationFixture("project_folder");
        const canonical = fixture.deployment.assets[0]!.version.canonical;
        if (canonical.kind !== "Skill") throw new Error("Skill missing");
        canonical.typeData.portableMetadata.metadata = Object.fromEntries([[key, "retained"]]);
        const before = structuredClone(fixture);
        expect((await cursorProvider.analyzeRender(fixture)).status).toBe("failed");
        expect(fixture).toEqual(before);
    });
});
