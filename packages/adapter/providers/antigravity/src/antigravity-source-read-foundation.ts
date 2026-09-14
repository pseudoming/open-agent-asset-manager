/** Pure candidate, reference, diagnostic, and path helpers for Antigravity reads. */

import * as crypto from "node:crypto";
import type { AssetKind, FileReferenceV2, OperationDiagnostic, SourceEvidence } from "@oaam/core";
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
    isPlainRecord as isRecord,
    isPortableSourcePattern as isPortablePattern,
    normalizePortableRelativeReference,
    portableBasename as basenamePath,
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
    basenamePath,
    compareText,
    compareVersionFile,
    decodeUtf8,
    isRecord,
    isPortablePattern,
    isWithin,
    metadataOrigins,
    nonBlank,
    parentPath,
    readDiagnostic,
    textEntry,
    uniquePreservingOrder,
    unknownKeys,
    withoutExtension,
};
import { antigravityFrontmatterString, type ParsedAntigravityFrontmatter } from "./antigravity-frontmatter";
import type { FileRecord, ScanResult, SourceContext } from "./antigravity-source-read-model";

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
        dialectId: "antigravity-source-v1",
        observedReadEntryId,
    });
}

export function sourceEvidence(
    scan: ScanResult,
    file: FileRecord,
    kind: Extract<SourceEvidence, { evidenceOrigin: "observed_read" }>["kind"],
    value: string,
): SourceEvidence[] {
    return buildObservedReadEvidence({
        observedReadEntryId: file.observedReadEntryId,
        kind,
        value,
        relativePath: file.relativePath,
        evidenceLevel: scan.capability.evidenceLevel,
    });
}

export function parseAtReferences(text: string): FileReferenceV2[] {
    const references: FileReferenceV2[] = [];
    let inFence = false;
    for (const line of text.split("\n")) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("```")) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        let cursor = 0;
        while (cursor < line.length) {
            const at = line.indexOf("@", cursor);
            if (at === -1) break;
            const previous = at === 0 ? "" : (line[at - 1] ?? "");
            if (at > 0 && !isWhitespace(previous)) {
                cursor = at + 1;
                continue;
            }
            let end = at + 1;
            while (end < line.length && !isWhitespace(line[end] ?? "")) end += 1;
            const rawTarget = (line.slice(at + 1, end).split("#")[0] ?? "").trim();
            if (isPlausibleFileTarget(rawTarget)) {
                references.push({
                    kind: "include",
                    rawTarget,
                    required: false,
                    diagnostics: [],
                    resolution: isExternalReferenceTarget(rawTarget) ? "external" : "unresolved",
                });
            }
            cursor = end;
        }
    }
    return references;
}

export function parseWorkflowReferences(text: string): FileReferenceV2[] {
    const references: FileReferenceV2[] = [];
    let inFence = false;
    for (const line of text.split("\n")) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("```")) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        for (let index = 0; index < line.length; index += 1) {
            if (line[index] !== "/") continue;
            const previous = index === 0 ? "" : (line[index - 1] ?? "");
            if (index > 0 && !isWhitespace(previous) && previous !== "(") continue;
            let end = index + 1;
            while (end < line.length && isCommandCharacter(line[end] ?? "")) end += 1;
            const rawTarget = line.slice(index + 1, end);
            if (rawTarget !== "") {
                references.push({
                    kind: "execute",
                    rawTarget,
                    required: false,
                    diagnostics: [],
                    resolution: "unresolved",
                });
            }
            index = end;
        }
    }
    return uniqueReferences(references);
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

export function frontmatterDiagnostics(parsed: ParsedAntigravityFrontmatter, path: string): OperationDiagnostic[] {
    return projectBoundedFrontmatterDiagnostics(
        parsed,
        () =>
            readDiagnostic(
                "antigravity.frontmatter_unclosed",
                "Antigravity declaration frontmatter is not closed",
                "invalid_schema",
                "error",
                path,
            ),
        (message) => readDiagnostic("antigravity.frontmatter_unsupported", message, "invalid_schema", "error", path),
    );
}

export function frontmatterStringDiagnostics(
    parsed: ParsedAntigravityFrontmatter,
    keys: string[],
    kind: string,
    path: string,
): OperationDiagnostic[] {
    return keys.flatMap((key) =>
        parsed.presentKeys.includes(key) && antigravityFrontmatterString(parsed, key) === undefined
            ? [
                  readDiagnostic(
                      "antigravity.frontmatter_string_field_invalid",
                      `${kind} frontmatter field ${key} must be a string`,
                      "invalid_schema",
                      "error",
                      path,
                  ),
              ]
            : [],
    );
}

export function unknownFieldDiagnostic(kind: string, keys: string[], path: string): OperationDiagnostic {
    return readDiagnostic(
        "antigravity.unknown_behavioral_frontmatter",
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
    diagnostics.push(
        readDiagnostic(
            "antigravity.declaration_not_utf8",
            `${kind} declaration is not valid UTF-8 and was not collected`,
            "invalid_schema",
            "error",
            file.relativePath,
        ),
    );
}

export function isFolderSkillEntry(path: string, bases: string[]): boolean {
    const base = sourceBasesContaining(path, bases);
    if (base === null) return false;
    const relative = base === "" ? path : path.slice(base.length + 1);
    const segments = relative.split("/");
    return segments.length === 2 && segments[0] !== "" && segments[1] === "SKILL.md";
}

export function isFlatSkillEntry(path: string, bases: string[]): boolean {
    const base = sourceBasesContaining(path, bases);
    if (base === null) return false;
    const relative = base === "" ? path : path.slice(base.length + 1);
    return !relative.includes("/") && relative.endsWith(".md") && relative !== "SKILL.md";
}

export function skillLogicalPath(file: FileRecord, folder: string | null): string {
    if (folder === null) return "SKILL.md";
    return relativeWithin(file.relativePath, folder);
}

export function candidateIdFor(kind: AssetKind, scan: ScanResult, relativePath: string): string {
    const digest = crypto
        .createHash("sha256")
        .update(`${kind}\0${scan.obligation.sourceReadObligationId}\0${relativePath}`, "utf8")
        .digest("hex");
    return `antigravity:${kind}:${digest}`;
}

export function unknownRecordKeys(record: Record<string, unknown>, allowed: string[]): string[] {
    const accepted = new Set(allowed);
    return Object.keys(record)
        .filter((key) => !accepted.has(key))
        .sort(compareText);
}

export function nonBlankString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function isUnderAny(path: string, bases: string[]): boolean {
    return bases.some((base) => base === "" || path.startsWith(`${base}/`));
}

function sourceBasesContaining(path: string, bases: string[]): string | null {
    return bases.find((base) => base === "" || path.startsWith(`${base}/`)) ?? null;
}

function normalizeRelativeReference(rawTarget: string, sourceParent: string): string | null {
    return normalizePortableRelativeReference(rawTarget, sourceParent, isExternalReferenceTarget);
}

function isExternalReferenceTarget(value: string): boolean {
    if (value.startsWith("/") || value.startsWith("~/") || value.startsWith("\\")) return true;
    const separator = value.indexOf(":");
    if (separator <= 0) return false;
    for (let index = 0; index < separator; index += 1) {
        const character = value[index] ?? "";
        const code = character.charCodeAt(0);
        const allowed =
            (code >= 48 && code <= 57) ||
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            character === "+" ||
            character === "-" ||
            character === ".";
        if (!allowed) return false;
    }
    return true;
}

function isPlausibleFileTarget(value: string): boolean {
    if (value === "" || value === "/") return false;
    return value.includes("/") || value.includes(".") || value.startsWith("~");
}

function uniqueReferences(references: FileReferenceV2[]): FileReferenceV2[] {
    const seen = new Set<string>();
    return references.filter((reference) => {
        const key = `${reference.kind}\0${reference.rawTarget}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function isCommandCharacter(value: string): boolean {
    const code = value.charCodeAt(0);
    return (
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        value === "-" ||
        value === "_" ||
        value === ":"
    );
}
