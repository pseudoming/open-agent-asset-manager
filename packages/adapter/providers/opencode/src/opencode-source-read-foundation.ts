/** Shared OpenCode candidate, diagnostic, reference, and ordering mechanics. */

import * as crypto from "node:crypto";
import type {
    AssetKind,
    FileReferenceV2,
    OperationDiagnostic,
    ProviderReadEntryDisposition,
    ReadEntryHandle,
    SourceEvidence,
    SourceReadObligation,
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
    isPlainRecord as isRecord,
    normalizePortableRelativeReference,
    portableBasename as basenamePath,
    portableParentPath as parentPath,
    portablePathWithoutExtension as withoutExtension,
    relativePortablePath as relativeWithin,
    sourceReadDiagnostic as readDiagnostic,
    trimNonBlankText as nonBlank,
    uniqueStringsPreservingOrder as uniquePreservingOrder,
} from "@oaam/adapter-framework";
export { buildSeparateNativeRepresentation as separateNative } from "@oaam/adapter-framework";
export {
    basenamePath,
    compareText,
    compareVersionFile,
    decodeUtf8,
    isRecord,
    isWhitespace,
    isWithin,
    metadataOrigins,
    nonBlank,
    parentPath,
    readDiagnostic,
    relativeWithin,
    textEntry,
    uniquePreservingOrder,
    withoutExtension,
};
import type { FileRecord, ScanResult, SourceContext } from "./opencode-source-read-model";

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
        scopePath: scopePathFor(context, sourcePath),
        displayName: sourcePath,
        dialectId: "opencode-source-v1",
        observedReadEntryId,
    });
}

export function scopePathFor(context: SourceContext, sourcePath: string): string {
    if (context.scope !== "project") return "";
    if (["AGENTS.md", "CLAUDE.md", "CONTEXT.md"].includes(basenamePath(sourcePath))) {
        return parentPath(sourcePath);
    }
    return "";
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

export function parseOpenCodeAtReferenceTokens(text: string): string[] {
    const targets: string[] = [];
    const seen = new Set<string>();
    let index = 0;
    while (index < text.length) {
        const at = text.indexOf("@", index);
        if (at === -1) break;
        const previous = at === 0 ? "" : (text[at - 1] ?? "");
        if (at > 0 && (isWordCharacter(previous) || previous === "`")) {
            index = at + 1;
            continue;
        }
        let cursor = at + 1;
        let rawTarget = "";
        if (text[cursor] === ".") {
            rawTarget += ".";
            cursor += 1;
        }
        while (cursor < text.length && text[cursor] !== "." && !isAtReferenceDelimiter(text[cursor] ?? "")) {
            rawTarget += text[cursor];
            cursor += 1;
        }
        while (text[cursor] === ".") {
            const next = text[cursor + 1] ?? "";
            if (next === "" || next === "." || isAtReferenceDelimiter(next)) break;
            rawTarget += ".";
            cursor += 1;
            while (cursor < text.length && text[cursor] !== "." && !isAtReferenceDelimiter(text[cursor] ?? "")) {
                rawTarget += text[cursor];
                cursor += 1;
            }
        }
        if (rawTarget !== "" && !rawTarget.includes("\0") && !seen.has(rawTarget)) {
            seen.add(rawTarget);
            targets.push(rawTarget);
        }
        index = Math.max(cursor, at + 1);
    }
    return targets;
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
        isExternalTarget: isExternalReference,
    });
}

export function commandArguments(body: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < body.length; index += 1) {
        if (body[index] !== "$") continue;
        if (body.startsWith("$ARGUMENTS", index)) {
            values.push("ARGUMENTS");
            index += "$ARGUMENTS".length - 1;
            continue;
        }
        let end = index + 1;
        while (end < body.length && isDigit(body[end] ?? "")) end += 1;
        if (end > index + 1) {
            values.push(body.slice(index + 1, end));
            index = end - 1;
        }
    }
    return uniquePreservingOrder(values);
}

export function containsShellSubstitution(body: string): boolean {
    let cursor = 0;
    while (cursor < body.length) {
        const marker = body.indexOf("!`", cursor);
        if (marker === -1) return false;
        const end = body.indexOf("`", marker + 2);
        if (end !== -1) return true;
        cursor = marker + 2;
    }
    return false;
}

export function rejectNonUtf8(scan: ScanResult, file: FileRecord, kind: string, diagnostics: OperationDiagnostic[]): void {
    scan.ignoreRecord(file, "declaration_not_utf8");
    diagnostics.push(nonUtf8Diagnostic(kind, file.relativePath));
}

export function nonUtf8Diagnostic(kind: string, path: string): OperationDiagnostic {
    return readDiagnostic(
        "opencode.declaration_not_utf8",
        `${kind} declaration is not valid UTF-8`,
        "invalid_schema",
        "error",
        path,
    );
}

export function ignoredDisposition(
    obligation: SourceReadObligation,
    handle: ReadEntryHandle,
    reasonCode: string,
): ProviderReadEntryDisposition {
    return {
        readEntryDispositionId: dispositionId(handle),
        sourceReadObligationId: obligation.sourceReadObligationId,
        readEntryHandleId: handle.readEntryHandleId,
        disposition: "ignored",
        reasonCode,
    };
}

export function dispositionId(handle: ReadEntryHandle): string {
    return `disposition:${handle.readEntryHandleId}`;
}

export function candidateIdFor(
    kind: AssetKind,
    scan: ScanResult,
    relativePath: string,
    interpretationDialectId?: string,
): string {
    const digest = crypto
        .createHash("sha256")
        .update(
            `${kind}\0${scan.obligation.sourceRootId}\0${relativePath}${interpretationDialectId === undefined ? "" : `\0${interpretationDialectId}`}`,
            "utf8",
        )
        .digest("hex");
    return `opencode:${kind.toLowerCase()}:${digest}`;
}

export function declarationName(path: string, prefixes: string[]): string {
    const normalized = path.split("\\").join("/");
    for (const prefix of prefixes) {
        if (normalized.startsWith(prefix)) {
            const declarationPath = normalized.slice(prefix.length);
            return declarationPath === ".md" ? "" : withoutExtension(declarationPath);
        }
    }
    const declarationBasename = basenamePath(normalized);
    return declarationBasename === ".md" ? "" : withoutExtension(declarationBasename);
}

export function normalizeRelativeReference(rawTarget: string, sourceParent: string): string | null {
    return normalizePortableRelativeReference(rawTarget, sourceParent, isExternalReference);
}

export function isExternalReference(value: string): boolean {
    return value.startsWith("/") || value.startsWith("~/") || value.includes("://");
}

export function isCanonicalNativeRelativePath(path: string): boolean {
    if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
        return false;
    }
    return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isOwnedBySkillRoot(path: string, skillRoot: string, allSkillRoots: string[]): boolean {
    if (!isWithin(path, skillRoot)) return false;
    return !allSkillRoots.some(
        (nestedRoot) => nestedRoot !== skillRoot && isWithin(nestedRoot, skillRoot) && isWithin(path, nestedRoot),
    );
}

export function isUnderAny(path: string, bases: string[]): boolean {
    return bases.some((base) => isWithin(path, base));
}

export function compareHandle(left: ReadEntryHandle, right: ReadEntryHandle): number {
    return compareText(`${left.relativePath}\0${left.entryKind}`, `${right.relativePath}\0${right.entryKind}`);
}

export function isAtReferenceDelimiter(value: string): boolean {
    return isWhitespace(value) || value === "`" || value === ",";
}

export function isWordCharacter(value: string): boolean {
    return (value >= "a" && value <= "z") || (value >= "A" && value <= "Z") || isDigit(value) || value === "_";
}

export function isDigit(value: string): boolean {
    return value >= "0" && value <= "9";
}
