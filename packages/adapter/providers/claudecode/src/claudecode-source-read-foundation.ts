/** Pure candidate, reference, diagnostic, and path helpers for Claude Code reads. */

import type {
    AssetKind,
    FileReferenceV2,
    MemoryCatalogMemberBindingInputV1,
    OperationDiagnostic,
    SourceEvidence,
} from "@oaam/core";
import {
    buildCandidateMetadataOrigins as metadataOrigins,
    buildMarkdownLinkReferences,
    buildObservedReadEvidence,
    buildSourceCandidateBase,
    buildSourceTextEntry as textEntry,
    compareCodeUnitText as compareText,
    compareLogicalPath as compareVersionFile,
    decodeUtf8Strict as decodeUtf8,
    isAsciiWhitespace as isWhitespace,
    isPortablePathAtOrBelow as isWithin,
    isPortableSourcePattern as isPortablePattern,
    normalizePortableRelativeReference,
    portableBasename as basename,
    portableParentPath as parentPath,
    portablePathWithoutExtension as withoutExtension,
    projectBoundedFrontmatterDiagnostics,
    relativePortablePath as relativeWithin,
    sourceReadDiagnostic as readDiagnostic,
    trimNonBlankText as nonBlank,
    unknownSourceKeys as unknownKeys,
    uniqueStringsPreservingOrder as uniquePreservingOrder,
} from "@oaam/adapter-framework";
export { buildSeparateNativeRepresentation as separateNative } from "@oaam/adapter-framework";
export {
    basename,
    compareText,
    compareVersionFile,
    decodeUtf8,
    isPortablePattern,
    isWithin,
    metadataOrigins,
    nonBlank,
    parentPath,
    readDiagnostic,
    relativeWithin,
    textEntry,
    uniquePreservingOrder,
    unknownKeys,
    withoutExtension,
};
import type { ParsedClaudeFrontmatter } from "./claudecode-frontmatter";
import type { FileRecord, ScanResult, SourceContext } from "./claudecode-source-read-model";

export function candidateBase(
    context: SourceContext,
    scan: ScanResult,
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
        dialectId: "claudecode-source-v1",
        observedReadEntryId,
    });
}

export function sourceEvidence(scan: ScanResult, file: FileRecord, value: string): SourceEvidence[] {
    return buildObservedReadEvidence({
        observedReadEntryId: file.observedReadEntryId,
        kind: "document",
        value,
        relativePath: file.relativePath,
        evidenceLevel: scan.capability.evidenceLevel,
    });
}

export function parseClaudeIncludes(text: string): FileReferenceV2[] {
    const references: FileReferenceV2[] = [];
    let inFence = false;
    for (const originalLine of text.split("\n")) {
        const trimmed = originalLine.trimStart();
        if (trimmed.startsWith("```")) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        let cursor = 0;
        while (cursor < originalLine.length) {
            const at = originalLine.indexOf("@", cursor);
            if (at === -1) break;
            const previous = at === 0 ? "" : (originalLine[at - 1] ?? "");
            if (at > 0 && !isWhitespace(previous)) {
                cursor = at + 1;
                continue;
            }
            let end = at + 1;
            while (end < originalLine.length && !isWhitespace(originalLine[end] ?? "")) {
                end += 1;
            }
            const rawTarget =
                originalLine
                    .slice(at + 1, end)
                    .split("#")[0]
                    ?.split("\\ ")
                    .join(" ") ?? "";
            if (isPlausibleIncludeTarget(rawTarget)) {
                references.push({
                    kind: "include",
                    rawTarget,
                    required: false,
                    diagnostics: [],
                    resolution: rawTarget.startsWith("/") || rawTarget.startsWith("~/") ? "external" : "unresolved",
                });
            }
            cursor = end;
        }
    }
    return references;
}

export function parseMarkdownReferences(
    text: string,
    logicalPaths: ReadonlySet<string>,
    sourceLogicalPath: string,
): FileReferenceV2[] {
    return buildMarkdownLinkReferences({
        text,
        logicalPaths,
        sourceLogicalPath,
        normalizeRelativeTarget: normalizeRelativeReference,
        isExternalTarget: isExternalReferenceTarget,
    });
}

export function parseSlashCommandReferences(text: string): FileReferenceV2[] {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("/")) return [];
    const name = trimmed.slice(1).split(/\s/, 1)[0] ?? "";
    if (name === "") return [];
    return [
        {
            kind: "execute" as const,
            rawTarget: name,
            required: true,
            diagnostics: [],
            resolution: "unresolved" as const,
        },
    ];
}

export interface ParsedMemoryIndex {
    links: Map<string, { title: string; hint: string }>;
    members: MemoryCatalogMemberBindingInputV1[];
    issues: Array<{ code: "invalid_member" | "duplicate_member"; lineNumber: number }>;
}

export function parseMemoryIndex(text: string): ParsedMemoryIndex {
    const links = new Map<string, { title: string; hint: string }>();
    const members: MemoryCatalogMemberBindingInputV1[] = [];
    const issues: ParsedMemoryIndex["issues"] = [];
    for (const [lineIndex, line] of text.split("\n").entries()) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith("- [") && !trimmed.startsWith("* [") && !trimmed.startsWith("+ [")) continue;
        const openLabel = line.indexOf("[");
        const closeLabel = line.indexOf("](", openLabel + 1);
        const closeTarget = line.indexOf(")", closeLabel + 2);
        if (openLabel === -1 || closeLabel === -1 || closeTarget === -1) {
            issues.push({ code: "invalid_member", lineNumber: lineIndex + 1 });
            continue;
        }
        const title = line.slice(openLabel + 1, closeLabel).trim();
        const target =
            line
                .slice(closeLabel + 2, closeTarget)
                .trim()
                .split("#")[0] ?? "";
        const normalizedTarget = normalizeRelativeReference(target, "");
        if (title === "" || normalizedTarget === null) {
            issues.push({ code: "invalid_member", lineNumber: lineIndex + 1 });
            continue;
        }
        const remainder = line.slice(closeTarget + 1).trim();
        const hint = remainder.startsWith("—") ? remainder.slice(1).trim() : remainder;
        if (links.has(normalizedTarget)) {
            issues.push({ code: "duplicate_member", lineNumber: lineIndex + 1 });
            continue;
        }
        links.set(normalizedTarget, { title, hint });
        members.push({ rawTarget: normalizedTarget, routingTitle: title, routingHint: hint });
    }
    return { links, members, issues };
}

export function frontmatterDiagnostics(parsed: ParsedClaudeFrontmatter, path: string): OperationDiagnostic[] {
    return projectBoundedFrontmatterDiagnostics(
        parsed,
        () =>
            readDiagnostic(
                "claudecode.frontmatter_unclosed",
                "Claude declaration frontmatter is not closed",
                "invalid_schema",
                "error",
                path,
            ),
        (message) => readDiagnostic("claudecode.frontmatter_unsupported", message, "invalid_schema", "error", path),
    );
}

export function unknownFieldDiagnostic(kind: string, keys: string[], path: string): OperationDiagnostic {
    return readDiagnostic(
        "claudecode.unknown_behavioral_frontmatter",
        `${kind} has unsupported frontmatter fields: ${keys.join(", ")}`,
        "invalid_schema",
        "error",
        path,
    );
}

export function rejectNonUtf8Declaration(
    scan: ScanResult,
    file: FileRecord,
    kind: string,
    diagnostics: OperationDiagnostic[],
): void {
    scan.ignoreRecord(file, "declaration_not_utf8");
    diagnostics.push(nonUtf8DeclarationDiagnostic(kind, file.relativePath));
}

export function nonUtf8DeclarationDiagnostic(kind: string, path: string): OperationDiagnostic {
    return readDiagnostic(
        "claudecode.declaration_not_utf8",
        `${kind} declaration is not valid UTF-8 and was not collected`,
        "invalid_schema",
        "error",
        path,
    );
}

export function candidateIdFor(kind: AssetKind, scan: ScanResult, relativePath: string): string {
    return `claudecode:${kind}:${scan.obligation.sourceReadObligationId}:${relativePath}`;
}

export function commandRelativePath(path: string): string {
    const marker = "/commands/";
    const index = `/${path}`.indexOf(marker);
    return index === -1 ? basename(path) : `/${path}`.slice(index + marker.length);
}

export function commandName(relativePath: string): string {
    const segments = relativePath.split("/");
    if (segments[segments.length - 1] === "SKILL.md") segments.pop();
    else {
        segments[segments.length - 1] = withoutExtension(segments[segments.length - 1] ?? "workflow");
    }
    return segments.filter((segment) => segment !== "").join(":") || "workflow";
}

export function firstSegment(path: string): string {
    return path.split("/", 1)[0] ?? "";
}

export function isUnderAny(path: string, bases: string[]): boolean {
    return bases.some((base) => path.startsWith(`${base}/`));
}

function normalizeRelativeReference(rawTarget: string, sourceParent: string): string | null {
    return normalizePortableRelativeReference(rawTarget, sourceParent, isExternalReferenceTarget);
}

function isExternalReferenceTarget(value: string): boolean {
    if (value.startsWith("/") || value.startsWith("~/") || value.startsWith("\\")) {
        return true;
    }
    const separator = value.indexOf(":");
    if (separator <= 0) return false;
    const first = value.charCodeAt(0);
    if (!isAsciiLetter(first)) return false;
    for (let index = 1; index < separator; index += 1) {
        const code = value.charCodeAt(index);
        const allowed = isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 43 || code === 45 || code === 46;
        if (!allowed) return false;
    }
    return true;
}

function isAsciiLetter(code: number): boolean {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isPlausibleIncludeTarget(value: string): boolean {
    if (value === "" || value === "/") return false;
    const first = value[0] ?? "";
    const code = first.charCodeAt(0);
    return (
        value.startsWith("./") ||
        value.startsWith("~/") ||
        value.startsWith("/") ||
        first === "." ||
        first === "_" ||
        first === "-" ||
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122)
    );
}
