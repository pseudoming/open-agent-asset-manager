/** Pure Codex candidate, path, evidence, and diagnostic helpers. */

import type { AssetKind, SourceEvidence } from "@oaam/core";
import {
    buildCandidateMetadataOrigins as metadataOrigins,
    buildMarkdownLinkReferences,
    buildObservedReadEvidence,
    buildSeparateNativeRepresentation as separateNative,
    buildSourceCandidateBase,
    buildSourceTextEntry as textEntry,
    compareCodeUnitText as compareText,
    decodeUtf8Strict as decodeUtf8,
    isPortablePathAtOrBelow as isWithin,
    normalizePortableRelativeReference,
    portableBasename as basename,
    portableParentPath as parentPath,
    relativePortablePath as relativeWithin,
    sourceReadDiagnostic as readDiagnostic,
    trimNonBlankText as nonBlank,
} from "@oaam/adapter-framework";
import type { CodexFileRecord, CodexScanResult, CodexSourceContext } from "./codex-source-read-model";

export {
    basename,
    compareText,
    decodeUtf8,
    isWithin,
    metadataOrigins,
    nonBlank,
    parentPath,
    readDiagnostic,
    relativeWithin,
    separateNative,
    textEntry,
};

export function candidateBase(
    context: CodexSourceContext,
    scan: CodexScanResult,
    candidateId: string,
    sourcePath: string,
    observedReadEntryId: string,
) {
    return buildSourceCandidateBase({
        candidateId,
        sourceRootId: scan.obligation.sourceRootId,
        scope: context.scope,
        projectRootPath: context.projectRootPath,
        scopePath: context.layout === "project" ? parentPath(sourcePath) : "",
        displayName: basename(sourcePath),
        dialectId: "codex-source-v1",
        observedReadEntryId,
    });
}

export function candidateIdFor(kind: AssetKind, scan: CodexScanResult, relativePath: string): string {
    return `codex:${kind}:${scan.obligation.sourceReadObligationId}:${relativePath}`;
}

export function sourceEvidence(scan: CodexScanResult, file: CodexFileRecord, value: string): SourceEvidence[] {
    return buildObservedReadEvidence({
        observedReadEntryId: file.observedReadEntryId,
        kind: "document",
        value,
        relativePath: file.relativePath,
        evidenceLevel: scan.capability.evidenceLevel,
    });
}

export function isCanonicalNativeRelativePath(path: string): boolean {
    return (
        path !== "" &&
        !path.startsWith("/") &&
        !path.includes("\\") &&
        !path.includes("\0") &&
        path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
    );
}

export function isSafeGuidanceFallbackFilename(value: string): boolean {
    return (
        value.trim() !== "" &&
        value === value.trim() &&
        value !== "." &&
        value !== ".." &&
        !value.includes("/") &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        Buffer.byteLength(value, "utf8") <= 255
    );
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

export function codexSkillFolderForEntry(path: string, layout: "project" | "skill_root"): string | null {
    const segments = path.split("/");
    if (layout === "skill_root") {
        return segments.length === 2 && segments[0] !== "" && segments[0] !== ".system" && segments[1] === "SKILL.md"
            ? segments[0]
            : null;
    }
    return segments.length === 4 &&
        (segments[0] === ".agents" || segments[0] === ".codex") &&
        segments[1] === "skills" &&
        segments[2] !== "" &&
        segments[2] !== ".system" &&
        segments[3] === "SKILL.md"
        ? segments.slice(0, 3).join("/")
        : null;
}
