/** ZCode Markdown-command and script Workflow candidate builders. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic, WorkflowTypeDataV2 } from "@oaam/core";
import { parseZcodeCommandFrontmatter } from "./zcode-frontmatter";
import {
    commandArgumentNames,
    commandCommaList,
    containsUnsupportedShellExpansion,
    fallbackDescription,
    frontmatterDiagnostics,
    modelSelection,
    optionalBoolean,
    optionalString,
    unknownFieldDiagnostic,
    workflowToolSelectors,
} from "./zcode-source-read-fields";
import {
    candidateBase,
    candidateIdFor,
    commandBasesForLayout,
    metadataOrigins,
    readDiagnostic,
    relativeWithin,
    separateNative,
    sourceEvidence,
    textEntry,
    withoutExtension,
} from "./zcode-source-read-foundation";
import { parseZcodeScriptWorkflowMeta } from "./zcode-source-read-javascript";
import {
    ZCODE_NATIVE_DIALECTS,
    type ZcodeFileRecord,
    type ZcodeScanResult,
    type ZcodeSourceContext,
} from "./zcode-source-read-model";

const COMMAND_FIELDS = new Set(["allowed-tools", "argument-hint", "description", "disable-noninteractive", "model", "skills"]);

export function buildWorkflowCandidates(context: ZcodeSourceContext, scan: ZcodeScanResult) {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.text === null) {
            scan.ignoreRecord(file, "workflow_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "zcode.workflow_not_utf8",
                    "ZCode Workflow declarations must be valid UTF-8",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const candidate = file.relativePath.toLowerCase().endsWith(".workflow.js")
            ? buildScriptWorkflow(context, scan, file)
            : buildCommandWorkflow(context, scan, file);
        candidates.push(candidate);
    }
    markDuplicateIdentities(candidates);
    return { candidates, diagnostics, ignoredSource };
}

function buildCommandWorkflow(
    context: ZcodeSourceContext,
    scan: ZcodeScanResult,
    file: ZcodeFileRecord,
): AdapterExtractedAssetCandidate {
    const parsed = parseZcodeCommandFrontmatter(file.text ?? "");
    const candidateDiagnostics = frontmatterDiagnostics(parsed, "Workflow", file.relativePath);
    const unknown = parsed.presentKeys.filter((key) => !COMMAND_FIELDS.has(key));
    if (unknown.length > 0) candidateDiagnostics.push(unknownFieldDiagnostic("Workflow", unknown, file.relativePath));
    const body = (parsed.hasFrontmatter && parsed.closed ? parsed.body : (file.text ?? "")).trim();
    const name = commandName(context, file.relativePath);
    if (!isCommandName(name)) {
        candidateDiagnostics.push(
            readDiagnostic(
                "zcode.workflow_name_invalid",
                "ZCode command names must be 1-64 lowercase letters, digits, underscore, colon, or dash",
                "invalid_schema",
                "error",
                file.relativePath,
            ),
        );
    }
    const declaredDescription = optionalString(parsed, "description", candidateDiagnostics, file.relativePath, "Workflow");
    const description =
        declaredDescription === undefined || declaredDescription.trim() === "" ? fallbackDescription(body) : declaredDescription;
    if (description.trim() === "") {
        candidateDiagnostics.push(
            readDiagnostic(
                "zcode.workflow_description_missing",
                "ZCode command requires an explicit description or a non-empty body",
                "invalid_schema",
                "error",
                file.relativePath,
            ),
        );
    }
    const preapproved = workflowToolSelectors(
        commandCommaList(parsed, "allowed-tools", candidateDiagnostics, file.relativePath) ?? [],
    );
    const skills = commandCommaList(parsed, "skills", candidateDiagnostics, file.relativePath) ?? [];
    if (skills.length > 0) {
        candidateDiagnostics.push(
            readDiagnostic(
                "zcode.workflow_skill_binding_pending",
                "ZCode command Skill dependencies require accepted Version bindings before import",
                "invalid_schema",
                "error",
                file.relativePath,
            ),
        );
    }
    const disableNonInteractive = optionalBoolean(
        parsed,
        "disable-noninteractive",
        candidateDiagnostics,
        file.relativePath,
        "Workflow",
    );
    if (disableNonInteractive === true) {
        candidateDiagnostics.push(
            readDiagnostic(
                "zcode.workflow_interactive_only_unowned",
                "ZCode interactive-only command availability has no lossless canonical Workflow field",
                "unsupported",
                "error",
                file.relativePath,
            ),
        );
    }
    if (containsUnsupportedShellExpansion(body)) {
        candidateDiagnostics.push(
            readDiagnostic(
                "zcode.workflow_shell_expansion_unsupported",
                "The current ZCode runtime rejects command shell expansion; OAAM preserved the native source but cannot import it as usable",
                "unsupported",
                "error",
                file.relativePath,
            ),
        );
    }
    const model = optionalString(parsed, "model", candidateDiagnostics, file.relativePath, "Workflow");
    const typeData: WorkflowTypeDataV2 = {
        schemaVersion: 2,
        name,
        description,
        implementation: {
            kind: "instructions",
            instructionDialectId: ZCODE_NATIVE_DIALECTS.commandWorkflow,
            execution: {
                mode: "caller",
                agent: { mode: "agent_runtime_default" },
                model: modelSelection(model),
                effort: { mode: "inherit" },
                shell: { mode: "none" },
            },
            toolPolicy: { preapproved, denied: [], otherwise: "inherit_agent_runtime_policy" },
        },
        invocation: {
            commandNames: [name],
            userInvocable: true,
            agentInvocable: false,
            argumentHint: optionalString(parsed, "argument-hint", candidateDiagnostics, file.relativePath, "Workflow") ?? "",
            argumentNames: commandArgumentNames(body),
        },
    };
    const complete = body.trim() !== "" && candidateDiagnostics.every((item) => item.severity !== "error");
    const candidateId = candidateIdFor("Workflow", scan, file.relativePath);
    const candidate: AdapterExtractedAssetCandidate = {
        ...candidateBase(context, scan, candidateId, file),
        scopePath: "",
        displayName: name,
        displayDescription: description,
        files: [textEntry("WORKFLOW.md", body)],
        nativeRepresentation: separateNative(ZCODE_NATIVE_DIALECTS.commandWorkflow, [file]),
        dialectRestorationTransition: { action: "inherit" },
        status: complete ? "complete" : "incomplete",
        assetCandidateStatus: complete ? "importable" : "incomplete",
        promotionSafety: "default_promotable",
        sourceFileOrigins: [{ logicalPath: "WORKFLOW.md", observedReadEntryIds: [file.observedReadEntryId] }],
        sourceContainerEntryIds: [],
        metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
        sourceEvidence: sourceEvidence(scan, file, "zcode_command_markdown"),
        diagnostics: candidateDiagnostics,
        kind: "Workflow",
        typeData,
        workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
    };
    scan.attachCandidate(candidateId, [file]);
    return candidate;
}

function buildScriptWorkflow(
    context: ZcodeSourceContext,
    scan: ZcodeScanResult,
    file: ZcodeFileRecord,
): AdapterExtractedAssetCandidate {
    const parsed = parseZcodeScriptWorkflowMeta(file.text ?? "");
    const candidateDiagnostics = parsed.issues.map((issue) =>
        readDiagnostic("zcode.script_workflow_meta_invalid", issue, "invalid_schema", "error", file.relativePath),
    );
    const name = parsed.name ?? scriptNameFromPath(file.relativePath);
    const description = parsed.description ?? "";
    const typeData: WorkflowTypeDataV2 = {
        schemaVersion: 2,
        name,
        description,
        implementation: { kind: "executable", executableDialectId: ZCODE_NATIVE_DIALECTS.scriptWorkflow },
        invocation: {
            commandNames: [name],
            userInvocable: true,
            agentInvocable: true,
            argumentHint: "",
            argumentNames: [],
        },
    };
    const complete = (file.text ?? "").trim() !== "" && candidateDiagnostics.length === 0;
    const candidateId = candidateIdFor("Workflow", scan, file.relativePath);
    const candidate: AdapterExtractedAssetCandidate = {
        ...candidateBase(context, scan, candidateId, file),
        scopePath: "",
        displayName: name,
        displayDescription: description,
        files: [
            {
                ...textEntry("workflow.js", file.text ?? ""),
                mediaType: "text/javascript",
                executable: file.executable,
            },
        ],
        nativeRepresentation: separateNative(ZCODE_NATIVE_DIALECTS.scriptWorkflow, [file]),
        dialectRestorationTransition: { action: "inherit" },
        status: complete ? "complete" : "incomplete",
        assetCandidateStatus: complete ? "importable" : "incomplete",
        promotionSafety: "default_promotable",
        sourceFileOrigins: [{ logicalPath: "workflow.js", observedReadEntryIds: [file.observedReadEntryId] }],
        sourceContainerEntryIds: [],
        metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
        sourceEvidence: sourceEvidence(scan, file, "zcode_script_workflow_javascript"),
        diagnostics: candidateDiagnostics,
        kind: "Workflow",
        typeData,
        workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
    };
    scan.attachCandidate(candidateId, [file]);
    return candidate;
}

function commandName(context: ZcodeSourceContext, path: string): string {
    const base = commandBasesForLayout(context.layout).find((candidate) => candidate === "" || path.startsWith(`${candidate}/`));
    const relative = base === undefined || base === "" ? path : relativeWithin(path, base);
    return withoutExtension(relative)
        .split("/")
        .filter((segment) => segment !== "")
        .join(":")
        .toLowerCase();
}

function scriptNameFromPath(path: string): string {
    const filename = path.split("/").at(-1) ?? path;
    return filename.toLowerCase().endsWith(".workflow.js") ? filename.slice(0, -".workflow.js".length) : filename;
}

function isCommandName(value: string): boolean {
    if (value.length < 1 || value.length > 64 || !isLowerLetterOrDigit(value[0] ?? "")) return false;
    return [...value].every(
        (character) => isLowerLetterOrDigit(character) || character === "_" || character === ":" || character === "-",
    );
}

function isLowerLetterOrDigit(value: string): boolean {
    return (value >= "a" && value <= "z") || (value >= "0" && value <= "9");
}

function markDuplicateIdentities(candidates: AdapterExtractedAssetCandidate[]): void {
    const counts = new Map<string, number>();
    for (const candidate of candidates) counts.set(candidate.displayName, (counts.get(candidate.displayName) ?? 0) + 1);
    for (const candidate of candidates) {
        if ((counts.get(candidate.displayName) ?? 0) < 2) continue;
        candidate.status = "incomplete";
        candidate.assetCandidateStatus = "incomplete";
        candidate.diagnostics.push(
            readDiagnostic(
                "zcode.workflow_duplicate_identity",
                "Multiple Workflow declarations in this source root resolve to the same ZCode name",
                "conflict",
                "error",
                candidate.displayName,
            ),
        );
    }
}
