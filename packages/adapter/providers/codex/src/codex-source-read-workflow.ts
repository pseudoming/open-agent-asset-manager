/** Codex deprecated Custom Prompt Workflow candidate builder. */

import { projectBoundedFrontmatterDiagnostics } from "@oaam/adapter-framework";
import type { AdapterExtractedAssetCandidate, OperationDiagnostic, WorkflowTypeDataV2 } from "@oaam/core";
import { frontmatterString, parseCodexFrontmatter } from "./codex-frontmatter";
import {
    candidateBase,
    candidateIdFor,
    metadataOrigins,
    nonBlank,
    readDiagnostic,
    separateNative,
    sourceEvidence,
    textEntry,
} from "./codex-source-read-foundation";
import { CODEX_NATIVE_DIALECTS, type CodexScanResult, type CodexSourceContext } from "./codex-source-read-model";

const PROMPT_FIELDS = new Set(["description", "argument-hint"]);

export function buildWorkflowCandidates(context: CodexSourceContext, scan: CodexScanResult) {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const relativePath of scan.unreadableRelativePaths.filter(isPromptPath)) {
        diagnostics.push(
            readDiagnostic(
                "codex.workflow_source_unreadable",
                "Codex custom prompt exists but could not be read",
                "partial",
                "error",
                relativePath,
            ),
        );
        ignoredSource = true;
    }

    for (const file of scan.files.filter((item) => isPromptPath(item.relativePath))) {
        if (file.text === null) {
            scan.ignoreRecord(file, "workflow_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "codex.workflow_source_not_utf8",
                    "Codex custom prompts must be valid UTF-8",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }

        const parsed = parseCodexFrontmatter(file.text);
        const candidateDiagnostics = projectBoundedFrontmatterDiagnostics(
            parsed,
            () =>
                readDiagnostic(
                    "codex.workflow_frontmatter_unclosed",
                    "Codex custom-prompt frontmatter is not closed",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            (message) =>
                readDiagnostic("codex.workflow_frontmatter_invalid", message, "invalid_schema", "error", file.relativePath),
        );
        const unsupported = parsed.presentKeys.filter((key) => !PROMPT_FIELDS.has(key));
        if (unsupported.length > 0) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "codex.workflow_frontmatter_semantics_unsupported",
                    `Codex custom-prompt fields cannot be represented: ${unsupported.join(", ")}`,
                    "unsupported",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const description = optionalFrontmatterString(parsed, "description", candidateDiagnostics, file.relativePath);
        const argumentHint = optionalFrontmatterString(parsed, "argument-hint", candidateDiagnostics, file.relativePath);
        const body = parsed.hasFrontmatter && parsed.closed ? parsed.body : file.text;
        const name = filenameStem(file.relativePath);
        if (nonBlank(name) === undefined) {
            scan.ignoreRecord(file, "workflow_name_missing");
            diagnostics.push(
                readDiagnostic(
                    "codex.workflow_name_missing",
                    "Codex custom prompts require a non-empty filename stem",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const typeData: WorkflowTypeDataV2 = {
            schemaVersion: 2,
            name,
            description: description ?? "",
            implementation: {
                kind: "instructions",
                instructionDialectId: CODEX_NATIVE_DIALECTS.workflow,
                execution: {
                    mode: "caller",
                    agent: { mode: "agent_runtime_default" },
                    model: { mode: "inherit" },
                    effort: { mode: "inherit" },
                    shell: { mode: "none" },
                },
                toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
            },
            invocation: {
                commandNames: [`prompts:${name}`],
                userInvocable: true,
                agentInvocable: false,
                argumentHint: argumentHint ?? "",
                argumentNames: customPromptArguments(body),
            },
        };
        const complete = body.trim() !== "" && candidateDiagnostics.every((item) => item.severity !== "error");
        const logicalPath = "WORKFLOW.md";
        const candidateId = candidateIdFor("Workflow", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            scopePath: "",
            displayName: name,
            displayDescription: description ?? "",
            files: [textEntry(logicalPath, body)],
            nativeRepresentation: separateNative(CODEX_NATIVE_DIALECTS.workflow, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [{ logicalPath, observedReadEntryIds: [file.observedReadEntryId] }],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, description !== undefined),
            sourceEvidence: sourceEvidence(scan, file, "codex_custom_prompt_markdown"),
            diagnostics: candidateDiagnostics,
            kind: "Workflow",
            typeData,
            workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

function optionalFrontmatterString(
    parsed: ReturnType<typeof parseCodexFrontmatter>,
    key: string,
    diagnostics: OperationDiagnostic[],
    path: string,
): string | undefined {
    if (!parsed.presentKeys.includes(key)) return undefined;
    const value = frontmatterString(parsed, key);
    if (value === undefined) {
        diagnostics.push(
            readDiagnostic(
                "codex.workflow_frontmatter_field_invalid",
                `Codex custom-prompt field ${key} must be a string`,
                "invalid_schema",
                "error",
                path,
            ),
        );
    }
    return value;
}

export function customPromptArguments(body: string): string[] {
    const names: string[] = [];
    for (let index = 0; index < body.length; index += 1) {
        if (body[index] !== "$") continue;
        const next = body[index + 1] ?? "";
        if (next === "$") {
            index += 1;
            continue;
        }
        if (next >= "1" && next <= "9") {
            pushUnique(names, next);
            index += 1;
            continue;
        }
        if (next < "A" || next > "Z") continue;
        let end = index + 2;
        while (end < body.length) {
            const current = body[end] ?? "";
            const accepted = (current >= "A" && current <= "Z") || (current >= "0" && current <= "9") || current === "_";
            if (!accepted) break;
            end += 1;
        }
        const trailing = body[end] ?? "";
        if (trailing >= "a" && trailing <= "z") continue;
        pushUnique(names, body.slice(index + 1, end));
        index = end - 1;
    }
    return names;
}

function pushUnique(values: string[], value: string): void {
    if (!values.includes(value)) values.push(value);
}

function isPromptPath(path: string): boolean {
    const segments = path.split("/");
    return segments.length === 2 && segments[0] === "prompts" && path.endsWith(".md");
}

function filenameStem(path: string): string {
    const filename = path.split("/").at(-1) ?? "workflow";
    return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}
