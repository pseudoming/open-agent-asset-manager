/** Pure ZCode candidate, evidence, and diagnostic helpers. */

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
    portablePathWithoutExtension as withoutExtension,
    relativePortablePath as relativeWithin,
    sourceReadDiagnostic as readDiagnostic,
    trimNonBlankText as nonBlank,
} from "@oaam/adapter-framework";
import type { ZcodeFileRecord, ZcodeScanResult, ZcodeSourceContext } from "./zcode-source-read-model";

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
    withoutExtension,
};

export function candidateBase(
    context: ZcodeSourceContext,
    scan: ZcodeScanResult,
    candidateId: string,
    file: ZcodeFileRecord,
    sourcePath = file.relativePath,
) {
    return buildSourceCandidateBase({
        candidateId,
        sourceRootId: scan.obligation.sourceRootId,
        scope: context.scope,
        projectRootPath: context.projectRootPath,
        scopePath: context.layout === "project" ? parentPath(sourcePath) : "",
        displayName: basename(sourcePath),
        dialectId: "zcode-source-v1",
        observedReadEntryId: file.observedReadEntryId,
    });
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

export function skillFolderForEntry(path: string, base: string): string | null {
    const segments = path.split("/");
    const baseLength = base.split("/").filter((segment) => segment !== "").length;
    if (base !== "" && path !== base && !path.startsWith(`${base}/`)) return null;
    if (segments.length !== baseLength + 2 || segments.at(-1) !== "SKILL.md") return null;
    const folderName = segments.at(-2);
    if (folderName === undefined || folderName === "" || folderName === ".system") return null;
    return segments.slice(0, -1).join("/");
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

export function skillBasesForLayout(layout: ZcodeSourceContext["layout"]): string[] {
    if (layout === "memory" || layout === "command_root" || layout === "agent_root") return [];
    if (layout === "config") return ["skills"];
    if (layout === "project") return [".zcode/skills", ".agents/skills"];
    return [""];
}

export function commandBasesForLayout(layout: ZcodeSourceContext["layout"]): string[] {
    if (layout === "memory" || layout === "skill_root" || layout === "agent_root") return [];
    if (layout === "config") return ["commands"];
    if (layout === "project") return [".zcode/commands", ".agents/commands"];
    return [""];
}

export function scriptWorkflowBasesForLayout(layout: ZcodeSourceContext["layout"]): string[] {
    if (layout === "memory" || layout === "skill_root" || layout === "agent_root") return [];
    if (layout === "config") return ["workflows"];
    if (layout === "project") return [".zcode/workflows"];
    return layout === "command_root" ? [] : [""];
}

export function subagentBasesForLayout(layout: ZcodeSourceContext["layout"]): string[] {
    if (layout === "memory") return [];
    if (layout === "config") return ["agents"];
    if (layout === "project") return [".zcode/agents"];
    return layout === "command_root" || layout === "skill_root" ? [] : [""];
}

export function candidateIdFor(kind: AssetKind, scan: ZcodeScanResult, relativePath: string): string {
    return `zcode:${kind}:${scan.obligation.sourceReadObligationId}:${relativePath}`;
}

export function sourceEvidence(scan: ZcodeScanResult, file: ZcodeFileRecord, value: string): SourceEvidence[] {
    return buildObservedReadEvidence({
        observedReadEntryId: file.observedReadEntryId,
        kind: "document",
        value,
        relativePath: file.relativePath,
        evidenceLevel: scan.capability.evidenceLevel,
    });
}
