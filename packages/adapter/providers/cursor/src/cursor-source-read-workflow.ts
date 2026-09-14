/** Cursor project/personal command Workflow candidate builders. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic, WorkflowTypeDataV2 } from "@oaam/core";
import {
    cursorCandidateBase,
    cursorCandidateId,
    cursorSourceEvidence,
    metadataOrigins,
    readDiagnostic,
    separateNative,
    textEntry,
} from "./cursor-source-read-foundation";
import {
    CURSOR_NATIVE_DIALECTS,
    type CursorCandidateBuildResult,
    type CursorFileRecord,
    type CursorScanResult,
    type CursorSourceContext,
} from "./cursor-source-read-model";

export function buildCursorWorkflowCandidates(context: CursorSourceContext, scan: CursorScanResult): CursorCandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.text === null) {
            scan.ignoreRecord(file, "cursor_workflow_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "cursor.workflow_not_utf8",
                    "Cursor command declarations must be valid UTF-8 text",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const command = parseCursorCommand(context, file);
        const candidateId = cursorCandidateId("Workflow", scan, file.relativePath);
        const complete = file.text.trim() !== "" && command.diagnostics.every((item) => item.severity !== "error");
        const candidate: AdapterExtractedAssetCandidate = {
            ...cursorCandidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: command.typeData.name,
            displayDescription: command.typeData.description,
            files: [textEntry("WORKFLOW.md", file.text)],
            nativeRepresentation: separateNative(command.nativeDialectId, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [{ logicalPath: "WORKFLOW.md", observedReadEntryIds: [file.observedReadEntryId] }],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
            sourceEvidence: cursorSourceEvidence(
                scan,
                file,
                context.agentRuntimeId === "CURSOR_AGENT_CLI" ? "cursor_agent_command" : "cursor_app_command",
            ),
            diagnostics: command.diagnostics,
            kind: "Workflow",
            typeData: command.typeData,
            workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

export function parseCursorCommand(
    context: Pick<CursorSourceContext, "agentRuntimeId" | "layout">,
    file: Pick<CursorFileRecord, "relativePath" | "text">,
): {
    nativeDialectId: string;
    typeData: WorkflowTypeDataV2;
    diagnostics: OperationDiagnostic[];
} {
    const diagnostics: OperationDiagnostic[] = [];
    const commandPath = commandPathWithinRoot(context.layout, file.relativePath);
    const name = commandPath === null ? "" : removeCommandExtension(commandPath);
    const app = context.agentRuntimeId === "CURSOR_APP";
    if (commandPath === null || !isCursorCommandName(name, app)) {
        diagnostics.push(
            readDiagnostic(
                "cursor.workflow_name_invalid",
                app
                    ? "Cursor App command paths must contain only letters, digits, underscore, dash, and bounded subdirectories"
                    : "Cursor Agent command names must contain only letters, digits, underscore, or dash",
                "invalid_schema",
                "error",
                file.relativePath,
            ),
        );
    }
    const body = file.text ?? "";
    if (body.trim() === "") {
        diagnostics.push(
            readDiagnostic(
                "cursor.workflow_body_empty",
                "Cursor command instructions must not be empty",
                "invalid_schema",
                "error",
                file.relativePath,
            ),
        );
    }
    const nativeDialectId = app ? CURSOR_NATIVE_DIALECTS.appCommandWorkflow : CURSOR_NATIVE_DIALECTS.agentCommandWorkflow;
    return {
        nativeDialectId,
        typeData: {
            schemaVersion: 2,
            name,
            description: commandDescription(body, name),
            implementation: {
                kind: "instructions",
                instructionDialectId: nativeDialectId,
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
                commandNames: name === "" ? [] : [name],
                userInvocable: true,
                agentInvocable: false,
                argumentHint: "",
                argumentNames: cursorCommandArgumentNames(body),
            },
        },
        diagnostics,
    };
}

export function cursorCommandArgumentNames(body: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < body.length; index += 1) {
        if (body[index] !== "$") continue;
        if (body.startsWith("$ARGUMENTS", index)) {
            appendUnique(values, "ARGUMENTS");
            index += "$ARGUMENTS".length - 1;
            continue;
        }
        const previous = body[index - 1];
        if (previous !== undefined && /\w/u.test(previous)) continue;
        let end = index + 1;
        while (end < body.length && isDigit(body[end] ?? "")) end += 1;
        if (end > index + 1) {
            const raw = body.slice(index + 1, end);
            const position = Number(raw);
            const next = body[end];
            if (position >= 1 && position <= 99 && (next === undefined || !/\w/u.test(next))) appendUnique(values, raw);
            index = end - 1;
        }
    }
    return values;
}

export function commandPathWithinRoot(layout: CursorSourceContext["layout"], relativePath: string): string | null {
    const bases =
        layout === "config" ? ["commands/"] : layout === "project" ? [".cursor/commands/"] : [".cursor/commands/", "commands/"];
    const base = bases.find((candidate) => relativePath.startsWith(candidate));
    if (base === undefined) return null;
    const commandPath = relativePath.slice(base.length);
    return commandPath === "" || commandPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
        ? null
        : commandPath;
}

export function isCursorCommandPath(relativePath: string, app: boolean, scope: "project" | "global"): boolean {
    if (relativePath.includes("\0") || relativePath.includes("\\")) return false;
    const base = scope === "project" ? ".cursor/commands/" : "commands/";
    if (!relativePath.startsWith(base)) return false;
    const commandPath = relativePath.slice(base.length);
    const segments = commandPath.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
    const extensionAllowed = app ? commandPath.endsWith(".md") || commandPath.endsWith(".txt") : commandPath.endsWith(".md");
    if (!extensionAllowed) return false;
    if (!app && segments.length !== 1) return false;
    if (app && segments.length - 1 > 10) return false;
    return isCursorCommandName(removeCommandExtension(commandPath), app);
}

function removeCommandExtension(path: string): string {
    return path.endsWith(".txt") ? path.slice(0, -4) : path.endsWith(".md") ? path.slice(0, -3) : "";
}

function isCursorCommandName(name: string, app: boolean): boolean {
    if (name === "" || name.length > 512) return false;
    const segments = name.split("/");
    return (app || segments.length === 1) && segments.every((segment) => /^[A-Za-z0-9_-]{1,128}$/u.test(segment));
}

function commandDescription(body: string, fallback: string): string {
    const first = body.split("\n", 1)[0]?.trim() ?? "";
    if (first === "") return fallback;
    const heading = /^#+\s*(.+)$/u.exec(first);
    return heading?.[1]?.trim() || first;
}

function appendUnique(values: string[], value: string): void {
    if (!values.includes(value)) values.push(value);
}

function isDigit(value: string): boolean {
    return value >= "0" && value <= "9";
}
