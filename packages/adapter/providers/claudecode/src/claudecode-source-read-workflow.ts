/** Claude Code Markdown-command and JavaScript Workflow candidate builders. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic, WorkflowTypeDataV2 } from "@oaam/core";
import { buildSourceFileGraph } from "@oaam/adapter-framework";
import { parseClaudeFrontmatter } from "./claudecode-frontmatter";
import {
    CLAUDECODE_EFFORT_DIALECT,
    CLAUDECODE_MODEL_DIALECT,
    CLAUDECODE_SHELL_DIALECT,
    claudeBooleanFrontmatter,
    claudeExecutionAgent,
    claudeForkContext,
    claudeOptionalString,
    claudeStringList,
    claudeToolStrings,
    claudeWorkflowShell,
    effortTier,
    isClaudeRuntimeNativeAgent,
    modelTier,
    selectorTier,
    toolSelectorKey,
    toolSelectors,
} from "./claudecode-source-read-fields";
import {
    basename,
    candidateBase,
    candidateIdFor,
    compareText,
    commandName,
    commandRelativePath,
    frontmatterDiagnostics,
    isWithin,
    metadataOrigins,
    nonBlank,
    parentPath,
    readDiagnostic,
    relativeWithin,
    rejectNonUtf8Declaration,
    separateNative,
    sourceEvidence,
    textEntry,
    uniquePreservingOrder,
    unknownFieldDiagnostic,
    unknownKeys,
    withoutExtension,
} from "./claudecode-source-read-foundation";
import { parseJavaScriptWorkflowMeta } from "./claudecode-source-read-javascript";
import {
    CLAUDECODE_NATIVE_DIALECTS,
    type CandidateBuildResult,
    type DirectoryRecord,
    type FileRecord,
    type ScanResult,
    type SourceContext,
} from "./claudecode-source-read-model";

export function buildWorkflowCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    const javascriptFiles = scan.files.filter((file) => isJavaScriptWorkflowPath(file.relativePath, context.layout));
    const javascriptEntries = javascriptFiles
        .filter((file) => file.text !== null && parseJavaScriptWorkflowMeta(file.text).name !== undefined)
        .sort(
            (left, right) =>
                left.relativePath.split("/").length - right.relativePath.split("/").length ||
                compareText(left.relativePath, right.relativePath),
        );
    const attachedJavaScriptRecordIds = new Set<string>();
    const processedDirectoryGraphs = new Set<string>();
    const javascriptBase = context.layout === "memory" ? null : javascriptWorkflowBase(context.layout);
    for (const entry of javascriptEntries) {
        if (attachedJavaScriptRecordIds.has(entry.observedReadEntryId)) continue;
        const folder = parentPath(entry.relativePath);
        const useDirectoryGraph = javascriptBase === null || folder !== javascriptBase;
        if (useDirectoryGraph && processedDirectoryGraphs.has(folder)) continue;
        if (useDirectoryGraph) processedDirectoryGraphs.add(folder);
        const sourceFiles = (useDirectoryGraph ? scan.files.filter((file) => isWithin(file.relativePath, folder)) : [entry]).sort(
            (left, right) => compareText(left.relativePath, right.relativePath),
        );
        const competingEntries = useDirectoryGraph
            ? javascriptEntries.filter((candidate) => isWithin(candidate.relativePath, folder))
            : [entry];
        const folderRecord = useDirectoryGraph
            ? scan.directories.find((directory) => directory.relativePath === folder)
            : undefined;
        const built = buildJavaScriptWorkflow(
            context,
            scan,
            entry,
            sourceFiles,
            folder,
            folderRecord,
            competingEntries.length === 1,
        );
        candidates.push(built.candidate);
        diagnostics.push(...built.diagnostics);
        for (const record of sourceFiles) attachedJavaScriptRecordIds.add(record.observedReadEntryId);
    }
    for (const file of scan.files) {
        if (attachedJavaScriptRecordIds.has(file.observedReadEntryId)) continue;
        if (file.text === null) {
            if (isJavaScriptWorkflowPath(file.relativePath, context.layout) || file.relativePath.endsWith(".md")) {
                rejectNonUtf8Declaration(scan, file, "Workflow", diagnostics);
            } else {
                scan.ignoreRecord(file, "unowned_workflow_resource");
            }
            ignoredSource = true;
            continue;
        }
        if (isJavaScriptWorkflowPath(file.relativePath, context.layout)) {
            const built = buildJavaScriptWorkflow(context, scan, file, [file], parentPath(file.relativePath), undefined, true);
            candidates.push(built.candidate);
            diagnostics.push(...built.diagnostics);
            continue;
        }
        if (!file.relativePath.endsWith(".md")) {
            scan.ignoreRecord(file, "unowned_workflow_resource");
            ignoredSource = true;
            continue;
        }
        const parsed = parseClaudeFrontmatter(file.text);
        const candidateDiagnostics = frontmatterDiagnostics(parsed, file.relativePath);
        const unsupported = unknownKeys(parsed, [
            "name",
            "description",
            "argument-hint",
            "arguments",
            "allowed-tools",
            "disallowed-tools",
            "user-invocable",
            "disable-model-invocation",
            "model",
            "effort",
            "context",
            "agent",
            "shell",
            "hide-from-slash-command-tool",
            "hooks",
            "paths",
        ]);
        if (unsupported.length > 0) {
            candidateDiagnostics.push(unknownFieldDiagnostic("Workflow", unsupported, file.relativePath));
        }
        for (const key of ["hide-from-slash-command-tool", "hooks", "paths"]) {
            if (parsed.presentKeys.includes(key)) {
                candidateDiagnostics.push(
                    readDiagnostic(
                        "claudecode.workflow_unowned_behavior",
                        `Workflow field ${key} has no lossless v1 canonical owner`,
                        "invalid_schema",
                        "error",
                        file.relativePath,
                    ),
                );
            }
        }
        const body = parsed.hasFrontmatter && parsed.closed ? parsed.body : file.text;
        const relative = commandRelativePath(file.relativePath);
        const name =
            nonBlank(claudeOptionalString(parsed, "name", candidateDiagnostics, file.relativePath, "Workflow")) ??
            commandName(relative);
        const description =
            claudeOptionalString(parsed, "description", candidateDiagnostics, file.relativePath, "Workflow") ?? "";
        if (description.trim() === "") {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.workflow_description_missing",
                    "Workflow description is missing",
                    "invalid_schema",
                    "warning",
                    file.relativePath,
                ),
            );
        }
        const preapproved = toolSelectors(
            claudeToolStrings(parsed, "allowed-tools", candidateDiagnostics, file.relativePath, "Workflow") ?? [],
        );
        const denied = toolSelectors(
            claudeToolStrings(parsed, "disallowed-tools", candidateDiagnostics, file.relativePath, "Workflow") ?? [],
        );
        const deniedKeys = new Set(denied.map(toolSelectorKey));
        const filteredPreapproved = preapproved.filter((selector) => !deniedKeys.has(toolSelectorKey(selector)));
        if (filteredPreapproved.length !== preapproved.length) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.workflow_tool_overlap",
                    "Deny precedence removed overlapping Workflow preapproval selectors",
                    "conflict",
                    "warning",
                    file.relativePath,
                ),
            );
        }
        const isolated = claudeForkContext(parsed, candidateDiagnostics, file.relativePath, "Workflow");
        const rawAgent = claudeExecutionAgent(parsed, isolated, candidateDiagnostics, file.relativePath, "Workflow");
        const model = selectorTier(
            claudeOptionalString(parsed, "model", candidateDiagnostics, file.relativePath, "Workflow"),
            CLAUDECODE_MODEL_DIALECT,
            modelTier,
        );
        const effort = selectorTier(
            claudeOptionalString(parsed, "effort", candidateDiagnostics, file.relativePath, "Workflow"),
            CLAUDECODE_EFFORT_DIALECT,
            effortTier,
        );
        const shell = claudeWorkflowShell(parsed, candidateDiagnostics, file.relativePath);
        const typeData: WorkflowTypeDataV2 = {
            schemaVersion: 2,
            name,
            description,
            implementation: {
                kind: "instructions",
                instructionDialectId: CLAUDECODE_NATIVE_DIALECTS.commandWorkflow,
                execution: {
                    mode: isolated ? "isolated" : "caller",
                    agent:
                        !isolated || rawAgent === undefined
                            ? { mode: "agent_runtime_default" }
                            : { mode: "agent_runtime_named", selector: rawAgent },
                    model,
                    effort,
                    shell: {
                        mode: "selected",
                        dialectId: CLAUDECODE_SHELL_DIALECT,
                        selector: shell,
                    },
                },
                toolPolicy: {
                    preapproved: filteredPreapproved,
                    denied,
                    otherwise: "inherit_agent_runtime_policy",
                },
            },
            invocation: {
                commandNames: [name],
                userInvocable:
                    claudeBooleanFrontmatter(parsed, "user-invocable", candidateDiagnostics, file.relativePath, "Workflow") ??
                    true,
                agentInvocable: !(
                    claudeBooleanFrontmatter(
                        parsed,
                        "disable-model-invocation",
                        candidateDiagnostics,
                        file.relativePath,
                        "Workflow",
                    ) ?? false
                ),
                argumentHint:
                    claudeOptionalString(parsed, "argument-hint", candidateDiagnostics, file.relativePath, "Workflow") ?? "",
                argumentNames: uniquePreservingOrder(
                    claudeStringList(parsed, "arguments", candidateDiagnostics, file.relativePath, "Workflow") ?? [],
                ),
            },
        };
        const complete = body.trim() !== "" && candidateDiagnostics.every((item) => item.severity !== "error");
        const candidateId = candidateIdFor("Workflow", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: name,
            displayDescription: description,
            files: [textEntry("WORKFLOW.md", body)],
            nativeRepresentation: separateNative(CLAUDECODE_NATIVE_DIALECTS.commandWorkflow, [file]),
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
            sourceEvidence: sourceEvidence(scan, file, "commands_DEPRECATED"),
            diagnostics: candidateDiagnostics,
            kind: "Workflow",
            typeData,
            workflowExecutionAgentBindingInput:
                !isolated || rawAgent === undefined
                    ? { bindingInputKind: "none" }
                    : {
                          bindingInputKind: "raw_selector",
                          rawTarget: rawAgent,
                          required: !isClaudeRuntimeNativeAgent(rawAgent),
                      },
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

function buildJavaScriptWorkflow(
    context: SourceContext,
    scan: ScanResult,
    entry: FileRecord,
    sourceFiles: FileRecord[],
    folder: string,
    folderRecord: DirectoryRecord | undefined,
    hasUniqueEntry: boolean,
): { candidate: AdapterExtractedAssetCandidate; diagnostics: OperationDiagnostic[] } {
    const meta = parseJavaScriptWorkflowMeta(entry.text ?? "");
    const diagnostics: OperationDiagnostic[] = [];
    if (meta.name === undefined) {
        diagnostics.push(
            readDiagnostic(
                "claudecode.workflow_js_meta_unresolved",
                "JavaScript Workflow meta.name was not a static string",
                "invalid_schema",
                "error",
                entry.relativePath,
            ),
        );
    }
    if (!hasUniqueEntry) {
        diagnostics.push(
            readDiagnostic(
                "claudecode.workflow_js_graph_ambiguous",
                "JavaScript Workflow directory contains more than one metadata-bearing entry and has no unique owned graph",
                "conflict",
                "error",
                folder,
            ),
        );
    }
    const name = meta.name ?? withoutExtension(basename(entry.relativePath));
    const typeData: WorkflowTypeDataV2 = {
        schemaVersion: 2,
        name,
        description: meta.description ?? "",
        implementation: {
            kind: "executable",
            executableDialectId: CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow,
        },
        invocation: {
            commandNames: [name],
            userInvocable: false,
            agentInvocable: true,
            argumentHint: "",
            argumentNames: [],
        },
    };
    const canonicalGraph = buildSourceFileGraph({
        sourceFiles,
        entry,
        entryText: entry.text ?? "",
        preserveEntryExecutable: true,
        logicalPathFor: (file) => relativeWithin(file.relativePath, folder),
        referencesFor: () => [],
    });
    const complete = entry.text?.trim() !== "" && diagnostics.length === 0;
    const candidateId = candidateIdFor("Workflow", scan, entry.relativePath);
    const originRecords: Array<FileRecord | DirectoryRecord> = [...sourceFiles];
    if (folderRecord !== undefined) originRecords.push(folderRecord);
    const candidate: AdapterExtractedAssetCandidate = {
        ...candidateBase(context, scan, candidateId, entry.relativePath, entry.observedReadEntryId),
        displayName: name,
        displayDescription: typeData.description,
        files: canonicalGraph.files,
        nativeRepresentation: separateNative(CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow, sourceFiles),
        dialectRestorationTransition: { action: "inherit" },
        status: complete ? "complete" : "incomplete",
        assetCandidateStatus: complete ? "importable" : "incomplete",
        promotionSafety: "default_promotable",
        sourceFileOrigins: canonicalGraph.sourceFileOrigins,
        sourceContainerEntryIds: folderRecord === undefined ? [] : [folderRecord.observedReadEntryId],
        metadataSourceOrigins: metadataOrigins(entry.observedReadEntryId, true),
        sourceEvidence: sourceEvidence(scan, entry, "claudecode_js_workflow"),
        diagnostics,
        kind: "Workflow",
        typeData,
        workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
    };
    scan.attachCandidate(candidateId, originRecords);
    return { candidate, diagnostics };
}

function isJavaScriptWorkflowPath(relativePath: string, layout: SourceContext["layout"]): boolean {
    return layout !== "memory" && relativePath.startsWith(`${javascriptWorkflowBase(layout)}/`) && relativePath.endsWith(".js");
}

function javascriptWorkflowBase(layout: Exclude<SourceContext["layout"], "memory">): string {
    return layout === "config" ? "workflows" : ".claude/workflows";
}
