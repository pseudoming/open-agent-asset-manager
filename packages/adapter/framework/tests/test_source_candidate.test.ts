import { describe, expect, it } from "vitest";
import {
    adapterOperationDiagnostic,
    buildCandidateMetadataOrigins,
    buildObservedReadEvidence,
    buildSourceCandidateBase,
    buildSourceTextEntry,
    probeDiagnostic,
    sourceReadDiagnostic,
} from "../src";

describe("runtime-neutral source candidate construction", () => {
    it("builds the invariant candidate base without choosing family semantics", () => {
        expect(
            buildSourceCandidateBase({
                candidateId: "candidate-1",
                sourceRootId: "root-1",
                scope: "project",
                projectRootPath: "/project",
                scopePath: "packages/app",
                displayName: "source.md",
                dialectId: "family-source-v1",
                observedReadEntryId: "entry-1",
            }),
        ).toEqual({
            candidateId: "candidate-1",
            sourceRootIds: ["root-1"],
            scope: "project",
            projectRootPath: "/project",
            scopePath: "packages/app",
            displayName: "source.md",
            displayDescription: "",
            files: [],
            nativeRepresentation: {
                representationSource: "canonical_files",
                dialectId: "family-source-v1",
            },
            dialectRestorationTransition: { action: "inherit" },
            status: "complete",
            assetCandidateStatus: "importable",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: [
                { metadataSubject: "display_name", observedReadEntryId: "entry-1" },
                { metadataSubject: "type_data", observedReadEntryId: "entry-1" },
            ],
            sourceEvidence: [],
            diagnostics: [],
        });
    });

    it("builds sorted metadata origins, observed evidence, and canonical text entries", () => {
        expect(buildCandidateMetadataOrigins("entry-1", true)).toEqual([
            { metadataSubject: "display_description", observedReadEntryId: "entry-1" },
            { metadataSubject: "display_name", observedReadEntryId: "entry-1" },
            { metadataSubject: "type_data", observedReadEntryId: "entry-1" },
        ]);
        expect(
            buildObservedReadEvidence({
                observedReadEntryId: "entry-1",
                kind: "frontmatter",
                value: "skill",
                relativePath: "demo/SKILL.md",
                evidenceLevel: "runtime_verified",
            }),
        ).toEqual([
            {
                evidenceOrigin: "observed_read",
                observedReadEntryId: "entry-1",
                kind: "frontmatter",
                value: "skill:demo/SKILL.md",
                evidenceLevel: "runtime_verified",
            },
        ]);
        expect(buildSourceTextEntry("GUIDANCE.md", "# Guidance\n")).toEqual({
            logicalPath: "GUIDANCE.md",
            role: "entry",
            contentKind: "text",
            mediaType: "text/markdown",
            text: "# Guidance\n",
            executable: false,
            references: [],
        });
    });

    it("constructs error and warning read diagnostics without family defaults", () => {
        expect(sourceReadDiagnostic("family.invalid", "invalid source", "invalid_schema", "error", "source.md")).toMatchObject({
            severity: "error",
            operation: "read",
            suggestedActions: ["skip"],
            path: "source.md",
        });
        expect(sourceReadDiagnostic("family.notice", "notice", "partial", "warning")).toMatchObject({
            severity: "warning",
            operation: "read",
            suggestedActions: [],
            path: "",
        });
        expect(
            adapterOperationDiagnostic("render", "family.render_notice", "render notice", "partial", "warning", "target.md"),
        ).toMatchObject({
            operation: "render",
            code: "family.render_notice",
            path: "target.md",
        });
        expect(
            probeDiagnostic("family.installation_missing", "runtime entry was not found", "not_found", "error", "/runtime"),
        ).toMatchObject({
            operation: "probe",
            code: "family.installation_missing",
            suggestedActions: ["skip"],
            path: "/runtime",
        });
        expect(probeDiagnostic("family.discovery_partial", "discovery was partial", "partial", "warning")).toMatchObject({
            operation: "probe",
            path: "",
            suggestedActions: [],
        });
        expect(
            adapterOperationDiagnostic("inspect", "family.inspect_notice", "inspection notice", "partial", "warning"),
        ).toMatchObject({ operation: "inspect", path: "" });
    });
});
