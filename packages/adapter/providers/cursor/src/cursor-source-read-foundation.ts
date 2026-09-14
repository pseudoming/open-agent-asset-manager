/** Cursor candidate, evidence, diagnostic, and path helpers. */

import {
    buildCandidateMetadataOrigins,
    buildMarkdownLinkReferences,
    buildObservedReadEvidence,
    buildSeparateNativeRepresentation,
    buildSourceCandidateBase,
    buildSourceTextEntry,
    compareCodeUnitText,
    isPortablePathAtOrBelow,
    normalizePortableRelativeReference,
    portableBasename,
    portableParentPath,
    portablePathWithoutExtension,
    relativePortablePath,
    sourceReadDiagnostic,
    trimNonBlankText,
} from "@oaam/adapter-framework";
import type { SourceEvidence } from "@oaam/core";
import type { CursorFileRecord, CursorScanResult, CursorSourceContext } from "./cursor-source-read-model";

export {
    buildCandidateMetadataOrigins as metadataOrigins,
    buildSeparateNativeRepresentation as separateNative,
    buildSourceTextEntry as textEntry,
    compareCodeUnitText as compareText,
    isPortablePathAtOrBelow as isWithin,
    portableBasename as basename,
    portableParentPath as parentPath,
    portablePathWithoutExtension as withoutExtension,
    relativePortablePath as relativeWithin,
    sourceReadDiagnostic as readDiagnostic,
    trimNonBlankText as nonBlank,
};

export function cursorCandidateBase(
    context: CursorSourceContext,
    scan: CursorScanResult,
    candidateId: string,
    sourcePath: string,
    observedReadEntryId: string,
) {
    return buildSourceCandidateBase({
        candidateId,
        sourceRootId: scan.obligation.sourceRootId,
        scope: context.scope,
        projectRootPath: context.projectRootPath,
        scopePath: "",
        displayName: sourcePath,
        dialectId: "cursor-source-v1",
        observedReadEntryId,
    });
}

export function cursorSourceEvidence(scan: CursorScanResult, file: CursorFileRecord, value: string): SourceEvidence[] {
    return buildObservedReadEvidence({
        observedReadEntryId: file.observedReadEntryId,
        kind: "document",
        value,
        relativePath: file.relativePath,
        evidenceLevel: scan.capability.evidenceLevel,
    });
}

export function cursorCandidateId(
    kind: "Guidance" | "Rule" | "Workflow" | "Skill" | "Subagent" | "Memory",
    scan: CursorScanResult,
    relativePath: string,
): string {
    return `cursor:${kind}:${scan.obligation.sourceReadObligationId}:${relativePath}`;
}

export function parseMarkdownReferences(text: string, logicalPaths: ReadonlySet<string>, sourceLogicalPath: string) {
    const isExternalTarget = (value: string) => value.startsWith("/") || value.startsWith("~/") || value.includes("://");
    return buildMarkdownLinkReferences({
        text,
        logicalPaths,
        sourceLogicalPath,
        normalizeRelativeTarget: (value, sourceParent) =>
            normalizePortableRelativeReference(value, sourceParent, isExternalTarget),
        isExternalTarget,
    });
}

export function cursorSkillBases(layout: CursorSourceContext["layout"]): string[] {
    if (layout === "config") return ["skills"];
    if (layout === "project") return [".cursor/skills", ".agents/skills"];
    if (layout === "skill_root" || layout === "external") return [""];
    return [];
}
