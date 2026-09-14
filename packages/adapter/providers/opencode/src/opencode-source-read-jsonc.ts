/** OpenCode JSONC manifest recognition and bounded static parsing. */

import type { OperationDiagnostic } from "@oaam/core";
import { basenamePath, isRecord, isWhitespace, nonUtf8Diagnostic, readDiagnostic } from "./opencode-source-read-foundation";
import type { ScanResult, SourceLayout } from "./opencode-source-read-model";

export function isManifestPath(path: string, layout: SourceLayout): boolean {
    if (layout === "external") return isConfigManifestName(basenamePath(path));
    if (layout === "config") return !path.includes("/") && isConfigManifestName(path);
    return layout === "project" && !path.includes("/") && (path === "opencode.json" || path === "opencode.jsonc");
}

export function isConfigManifestName(name: string): boolean {
    return name === "config.json" || name === "opencode.json" || name === "opencode.jsonc";
}

export function parseJsoncObject(text: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(stripJsonc(text));
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function stripJsonc(text: string): string {
    const output: string[] = [];
    let state: "code" | "string" | "line_comment" | "block_comment" = "code";
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const current = text[index] ?? "";
        const next = text[index + 1] ?? "";
        if (state === "string") {
            output.push(current);
            if (escaped) escaped = false;
            else if (current === "\\") escaped = true;
            else if (current === '"') state = "code";
            continue;
        }
        if (state === "line_comment") {
            if (current === "\n" || current === "\r") {
                output.push(current);
                state = "code";
            } else output.push(" ");
            continue;
        }
        if (state === "block_comment") {
            if (current === "*" && next === "/") {
                output.push(" ", " ");
                index += 1;
                state = "code";
            } else output.push(current === "\n" || current === "\r" ? current : " ");
            continue;
        }
        if (current === '"') {
            output.push(current);
            state = "string";
        } else if (current === "/" && next === "/") {
            output.push(" ", " ");
            index += 1;
            state = "line_comment";
        } else if (current === "/" && next === "*") {
            output.push(" ", " ");
            index += 1;
            state = "block_comment";
        } else output.push(current);
    }
    return removeTrailingJsonCommas(output.join(""));
}

export function removeTrailingJsonCommas(text: string): string {
    const output: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const current = text[index] ?? "";
        if (inString) {
            output.push(current);
            if (escaped) escaped = false;
            else if (current === "\\") escaped = true;
            else if (current === '"') inString = false;
            continue;
        }
        if (current === '"') {
            inString = true;
            output.push(current);
            continue;
        }
        if (current !== ",") {
            output.push(current);
            continue;
        }
        let lookahead = index + 1;
        while (lookahead < text.length && isWhitespace(text[lookahead] ?? "")) lookahead += 1;
        if (text[lookahead] !== "}" && text[lookahead] !== "]") output.push(current);
    }
    return output.join("");
}
export function reportManifestFiles(
    scan: ScanResult,
    kind: "Workflow" | "Skill" | "Subagent",
    diagnostics: OperationDiagnostic[],
): boolean {
    let found = false;
    const sections = kind === "Workflow" ? ["commands", "command"] : kind === "Skill" ? ["skills"] : ["agents", "agent"];
    for (const file of scan.files.filter((item) => isConfigManifestName(basenamePath(item.relativePath)))) {
        scan.ignoreRecord(file, "manifest_fragment_not_version_authority");
        found = true;
        if (file.text === null) {
            diagnostics.push(nonUtf8Diagnostic(`${kind} manifest`, file.relativePath));
            continue;
        }
        const parsed = parseJsoncObject(file.text);
        if (parsed === null) {
            diagnostics.push(
                readDiagnostic(
                    "opencode.manifest_parse_failed",
                    "opencode JSON/JSONC could not be parsed by the bounded non-executing reader",
                    "invalid_schema",
                    "warning",
                    file.relativePath,
                ),
            );
            continue;
        }
        const presentSections = sections.filter((section) => Object.hasOwn(parsed, section));
        if (presentSections.length > 0) {
            diagnostics.push(
                readDiagnostic(
                    "opencode.manifest_fragment_deferred",
                    `The opencode ${presentSections.join("/")} section was detected but cannot become a Version until Core supports exact safe config fragments`,
                    "unsupported",
                    "warning",
                    file.relativePath,
                ),
            );
        }
    }
    return found;
}
