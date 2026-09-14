/** OpenCode command-Workflow candidate builder. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic, WorkflowTypeDataV2 } from "@oaam/core";
import { parseOpencodeFrontmatter } from "./opencode-frontmatter";
import {
    commandArguments,
    containsShellSubstitution,
    candidateBase,
    candidateIdFor,
    declarationName,
    metadataOrigins,
    nonBlank,
    readDiagnostic,
    rejectNonUtf8,
    separateNative,
    sourceEvidence,
    textEntry,
} from "./opencode-source-read-foundation";
import {
    frontmatterDiagnostics,
    optionalBoolean,
    optionalString,
    selectorTier,
    unknownFieldDiagnostic,
    unknownKeys,
} from "./opencode-source-read-fields";
import { isManifestPath, reportManifestFiles } from "./opencode-source-read-jsonc";
import {
    MODEL_DIALECT,
    NATIVE_AGENT_NAMES,
    OPENCODE_NATIVE_DIALECTS,
    VARIANT_DIALECT,
    type CandidateBuildResult,
    type ScanResult,
    type SourceContext,
} from "./opencode-source-read-model";

export function buildWorkflowCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = reportManifestFiles(scan, "Workflow", diagnostics);
    for (const file of scan.files.filter((item) => !isManifestPath(item.relativePath, context.layout))) {
        if (file.text === null) {
            rejectNonUtf8(scan, file, "Workflow", diagnostics);
            ignoredSource = true;
            continue;
        }
        const parsed = parseOpencodeFrontmatter(file.text);
        const candidateDiagnostics = frontmatterDiagnostics(parsed, file.relativePath);
        const unknown = unknownKeys(parsed, ["description", "agent", "model", "variant", "subtask"]);
        if (unknown.length > 0) {
            candidateDiagnostics.push(unknownFieldDiagnostic("Workflow", unknown, file.relativePath));
        }
        const description = optionalString(parsed, "description", candidateDiagnostics, file.relativePath, "Workflow") ?? "";
        const rawAgent = nonBlank(optionalString(parsed, "agent", candidateDiagnostics, file.relativePath, "Workflow"));
        const subtask = optionalBoolean(parsed, "subtask", candidateDiagnostics, file.relativePath, "Workflow");
        const isolated = subtask === true;
        if (subtask === undefined && rawAgent !== undefined) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "opencode.workflow_agent_mode_unresolved",
                    "A command agent without an explicit subtask flag depends on effective runtime agent mode",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const name = declarationName(file.relativePath, [".opencode/command/", ".opencode/commands/", "command/", "commands/"]);
        if (nonBlank(name) === undefined) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "opencode.workflow_name_missing",
                    "OpenCode Workflow requires a non-empty declaration filename",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const body = parsed.hasFrontmatter && parsed.closed ? parsed.body : file.text;
        const workflowReferences = scan.workflowReferencesByPath.get(file.relativePath) ?? {
            references: [],
            diagnostics: [],
            classificationHandles: [],
        };
        candidateDiagnostics.push(...workflowReferences.diagnostics);
        const model = optionalString(parsed, "model", candidateDiagnostics, file.relativePath, "Workflow");
        const variant = optionalString(parsed, "variant", candidateDiagnostics, file.relativePath, "Workflow");
        const typeData: WorkflowTypeDataV2 = {
            schemaVersion: 2,
            name,
            description,
            implementation: {
                kind: "instructions",
                instructionDialectId: "opencode-command-markdown-v1",
                execution: {
                    mode: isolated ? "isolated" : "caller",
                    agent:
                        rawAgent !== undefined
                            ? { mode: "agent_runtime_named", selector: rawAgent }
                            : { mode: "agent_runtime_default" },
                    model: selectorTier(model, MODEL_DIALECT),
                    effort: selectorTier(variant, VARIANT_DIALECT),
                    shell: containsShellSubstitution(body) ? { mode: "agent_runtime_default" } : { mode: "none" },
                },
                toolPolicy: {
                    preapproved: [],
                    denied: [],
                    otherwise: "inherit_agent_runtime_policy",
                },
            },
            invocation: {
                commandNames: [name],
                userInvocable: true,
                agentInvocable: false,
                argumentHint: "",
                argumentNames: commandArguments(body),
            },
        };
        const complete = body.trim() !== "" && candidateDiagnostics.every((item) => item.severity !== "error");
        const candidateId = candidateIdFor("Workflow", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: name,
            displayDescription: description,
            files: [
                {
                    ...textEntry("WORKFLOW.md", body),
                    references: workflowReferences.references,
                },
            ],
            nativeRepresentation: separateNative(OPENCODE_NATIVE_DIALECTS.commandWorkflow, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [
                {
                    logicalPath: "WORKFLOW.md",
                    observedReadEntryIds: [file.observedReadEntryId],
                },
            ],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
            sourceEvidence: sourceEvidence(scan, file, "opencode_command_markdown"),
            diagnostics: candidateDiagnostics,
            kind: "Workflow",
            typeData,
            workflowExecutionAgentBindingInput:
                rawAgent === undefined
                    ? { bindingInputKind: "none" }
                    : {
                          bindingInputKind: "raw_selector",
                          rawTarget: rawAgent,
                          required: !NATIVE_AGENT_NAMES.has(rawAgent),
                      },
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}
