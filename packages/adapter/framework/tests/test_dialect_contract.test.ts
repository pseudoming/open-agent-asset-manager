import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
    AssetVersionFileContentV2,
    NativeDialectValidationInputV1,
    PortableDialectSourceRuntimeV1,
    PortableEntryDialectValidationInputV1,
    PortableSelectorDialectUseV1,
} from "@oaam/core";
import {
    defineDialectComponentV1,
    defineNativeDialectContractV1,
    definePortableEntryDialectContractV1,
    definePortableSelectorDialectContractV1,
    hasCanonicalTextEntryV1,
} from "../src";

describe("provider dialect contract construction", () => {
    it("builds stable v1 components and the exact native contract skeleton", () => {
        const componentId = "family.skill.native-file-graph";
        expect(defineDialectComponentV1(componentId)).toEqual({
            componentId,
            componentVersion: 1,
            configFingerprint: `sha256:${crypto.createHash("sha256").update(`${componentId}\0v1`, "utf8").digest("hex")}`,
        });

        const validateSameContent = vi.fn((_input: NativeDialectValidationInputV1) => true);
        const contract = defineNativeDialectContractV1({
            kind: "Skill",
            dialectId: "family-skill-v1",
            validateSameContent,
        });
        expect(contract.definition).toMatchObject({
            kind: "Skill",
            dialectId: "family-skill-v1",
            rebaseMaterializer: null,
            targetApplicabilityPredicate: null,
            nativeFileGraphSchema: {
                componentId: "family-skill-v1.native-file-graph",
                componentVersion: 1,
            },
            contentNormalization: {
                componentId: "family-skill-v1.content-normalization",
                componentVersion: 1,
            },
            nativeToCanonicalParser: {
                componentId: "family-skill-v1.native-to-canonical-parser",
                componentVersion: 1,
            },
            canonicalConsistencyValidator: {
                componentId: "family-skill-v1.canonical-consistency-validator",
                componentVersion: 1,
            },
        });
        expect(contract.validateSameContent).toBe(validateSameContent);

        const rebaseMaterializer = defineDialectComponentV1("family-skill-v1.rebase-materializer");
        const rebaseContract = defineNativeDialectContractV1({
            kind: "Skill",
            dialectId: "family-skill-rebase-v1",
            rebaseMaterializer,
            validateSameContent,
        });
        const materialize = vi.fn(() => null);
        const callableContract = defineNativeDialectContractV1({
            kind: "Skill",
            dialectId: "family-skill-rebase-v1",
            rebaseMaterializer,
            rebase: { ref: structuredClone(rebaseMaterializer), materialize },
            validateSameContent,
        });
        expect(callableContract.definition).toEqual(rebaseContract.definition);
        expect(callableContract.rebase?.ref).toEqual(rebaseContract.definition.rebaseMaterializer);
        expect(callableContract.rebase?.materialize).toBe(materialize);
        expect(rebaseContract).not.toHaveProperty("rebase");
        rebaseMaterializer.componentId = "mutated-after-construction";
        expect(rebaseContract.definition.rebaseMaterializer).toMatchObject({
            componentId: "family-skill-v1.rebase-materializer",
            componentVersion: 1,
        });
    });

    it("recognizes only an exact canonical text entry", () => {
        expect(hasCanonicalTextEntryV1([canonicalFile("entry", "text")], "ENTRY.md")).toBe(true);
        expect(hasCanonicalTextEntryV1([canonicalFile("resource", "text")], "ENTRY.md")).toBe(false);
        expect(hasCanonicalTextEntryV1([canonicalFile("entry", "binary")], "ENTRY.md")).toBe(false);
        expect(hasCanonicalTextEntryV1([canonicalFile("entry", "text")], "OTHER.md")).toBe(false);
    });

    it("builds portable contracts while preserving provider callbacks and runtime snapshots", () => {
        const runtimeIds = ["SYNTHETIC_FOURTH_CLI"];
        const validateCanonicalEntry = vi.fn((_input: PortableEntryDialectValidationInputV1) => true);
        const validateSelector = vi.fn((_use: PortableSelectorDialectUseV1) => true);
        const validateSourceApplicability = vi.fn((_source: PortableDialectSourceRuntimeV1) => true);
        const entry = definePortableEntryDialectContractV1({
            kind: "Skill",
            field: "skill_entry",
            dialectId: "family-skill-entry-v1",
            applicableAgentRuntimeIds: runtimeIds,
            validateCanonicalEntry,
            validateSourceApplicability,
        });
        const selector = definePortableSelectorDialectContractV1({
            kind: "Subagent",
            field: "subagent_tool",
            dialectId: "family-tool-v1",
            applicableAgentRuntimeIds: runtimeIds,
            validateSelector,
            validateSourceApplicability,
        });
        runtimeIds.push("MUTATED_AFTER_CONSTRUCTION");

        expect(entry.definition).toMatchObject({
            kind: "Skill",
            field: "skill_entry",
            dialectId: "family-skill-entry-v1",
            applicableAgentRuntimeIds: ["SYNTHETIC_FOURTH_CLI"],
            canonicalEntryValidator: {
                componentId: "family-skill-entry-v1.skill_entry.portable-entry-validator",
            },
            sourceApplicabilityValidator: {
                componentId: "family-skill-entry-v1.skill_entry.source-applicability-validator",
            },
        });
        expect(entry.validateCanonicalEntry).toBe(validateCanonicalEntry);
        expect(entry.validateSourceApplicability).toBe(validateSourceApplicability);
        expect(selector.definition).toMatchObject({
            kind: "Subagent",
            field: "subagent_tool",
            dialectId: "family-tool-v1",
            applicableAgentRuntimeIds: ["SYNTHETIC_FOURTH_CLI"],
            selectorSemanticsValidator: {
                componentId: "family-tool-v1.subagent_tool.portable-selector-validator",
            },
            sourceApplicabilityValidator: {
                componentId: "family-tool-v1.subagent_tool.source-applicability-validator",
            },
        });
        expect(selector.validateSelector).toBe(validateSelector);
        expect(selector.validateSourceApplicability).toBe(validateSourceApplicability);
    });
});

function canonicalFile(role: "entry" | "resource", contentKind: "text" | "binary"): AssetVersionFileContentV2 {
    const file = {
        fileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        logicalPath: "ENTRY.md",
        role,
        contentHash: `sha256:${"0".repeat(64)}` as const,
        contentKind,
        mediaType: contentKind === "text" ? "text/markdown" : "application/octet-stream",
        byteSize: 0,
        executable: false,
        references: [],
    };
    return contentKind === "text"
        ? { file: { ...file, contentKind: "text" }, contentKind: "text", text: "" }
        : {
              file: { ...file, contentKind: "binary" },
              contentKind: "binary",
              bytes: new Uint8Array(),
          };
}
