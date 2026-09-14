/** Historical JSON and current Markdown Subagent candidate builders. */

import type {
    AdapterExtractedAssetCandidate,
    OperationDiagnostic,
    SubagentInstructionEntryV1,
    SubagentTypeDataV2,
} from "@oaam/core";
import {
    candidateBase,
    candidateIdFor,
    isRecord,
    metadataOrigins,
    nonBlankString,
    readDiagnostic,
    rejectNonUtf8Declaration,
    separateNative,
    sourceEvidence,
    textEntry,
    uniquePreservingOrder,
    unknownRecordKeys,
} from "./antigravity-source-read-foundation";
import {
    ANTIGRAVITY_NATIVE_DIALECTS,
    type CandidateBuildResult,
    type ScanResult,
    type SourceContext,
} from "./antigravity-source-read-model";
import { parseAntigravityMarkdownSubagent } from "./antigravity-subagent-markdown";

const TOOL_DIALECT = "antigravity-tool-name-v1";
const CONTEXT_DIALECT = "antigravity-context-sections-v1";

export function buildSubagentCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.text === null) {
            rejectNonUtf8Declaration(scan, file, "Subagent", diagnostics);
            ignoredSource = true;
            continue;
        }
        if (file.relativePath.endsWith(".md")) {
            const parsed = parseAntigravityMarkdownSubagent(file.text, file.relativePath);
            if (parsed.disposition === "ignored") {
                scan.ignoreRecord(file, parsed.excludedSource ? "excluded_subagent_source" : "invalid_subagent_source");
                ignoredSource = true;
                diagnostics.push(...parsed.diagnostics);
                continue;
            }
            const complete = parsed.diagnostics.every((item) => item.severity !== "error");
            const candidateId = candidateIdFor("Subagent", scan, file.relativePath);
            const candidate: AdapterExtractedAssetCandidate = {
                ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
                displayName: parsed.name,
                displayDescription: parsed.description,
                files: [textEntry("instructions.json", JSON.stringify(parsed.instruction))],
                nativeRepresentation: separateNative(ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown, [file]),
                dialectRestorationTransition: { action: "inherit" },
                status: complete ? "complete" : "incomplete",
                assetCandidateStatus: complete ? "importable" : "incomplete",
                promotionSafety: "default_promotable",
                sourceFileOrigins: [
                    {
                        logicalPath: "instructions.json",
                        observedReadEntryIds: [file.observedReadEntryId],
                    },
                ],
                sourceContainerEntryIds: [],
                metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
                sourceEvidence: sourceEvidence(scan, file, "frontmatter", "antigravity_subagent_markdown"),
                diagnostics: parsed.diagnostics,
                kind: "Subagent",
                typeData: parsed.typeData,
            };
            scan.attachCandidate(candidateId, [file]);
            candidates.push(candidate);
            continue;
        }
        const parsed = parseSubagentJson(file.text, file.relativePath);
        if (parsed.requiredMissing || parsed.excludedSource) {
            scan.ignoreRecord(file, parsed.excludedSource ? "excluded_subagent_source" : "invalid_subagent_source");
            ignoredSource = true;
            diagnostics.push(...parsed.diagnostics);
            continue;
        }
        const typeData: SubagentTypeDataV2 = {
            schemaVersion: 2,
            name: parsed.name,
            description: parsed.description,
            promptContextPolicy:
                parsed.includeSections === undefined
                    ? { mode: "agent_runtime_default" }
                    : {
                          mode: "selected",
                          dialectId: CONTEXT_DIALECT,
                          selectors: parsed.includeSections,
                      },
            tools: {
                availability: {
                    base:
                        parsed.toolNames === undefined
                            ? { mode: "inherit_available" }
                            : parsed.toolNames.length === 0
                              ? { mode: "none" }
                              : {
                                    mode: "allowlist",
                                    allowed: parsed.toolNames.map((selector) => ({
                                        mode: "agent_runtime_tool" as const,
                                        selector: {
                                            dialectId: TOOL_DIALECT,
                                            selector,
                                        },
                                    })),
                                },
                    unavailable: [],
                },
                permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission: { mode: "inherit" },
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling: { mode: "agent_runtime_default" },
                turnLimit: { mode: "agent_runtime_default" },
                model: { mode: "inherit" },
                effort: { mode: "inherit" },
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
            directInvocation: { mode: "agent_runtime_default" },
            presentation: {
                listing: parsed.hidden === undefined ? "agent_runtime_default" : parsed.hidden ? "hidden" : "visible",
                color: { mode: "agent_runtime_default" },
            },
        };
        const instruction: SubagentInstructionEntryV1 = {
            schemaVersion: 1,
            sections: parsed.sections,
        };
        const complete = parsed.diagnostics.every((item) => item.severity !== "error");
        const candidateId = candidateIdFor("Subagent", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: parsed.name,
            displayDescription: parsed.description,
            files: [textEntry("instructions.json", JSON.stringify(instruction))],
            nativeRepresentation: separateNative(ANTIGRAVITY_NATIVE_DIALECTS.subagent, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [
                {
                    logicalPath: "instructions.json",
                    observedReadEntryIds: [file.observedReadEntryId],
                },
            ],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
            sourceEvidence: sourceEvidence(scan, file, "document", "subagent_json"),
            diagnostics: parsed.diagnostics,
            kind: "Subagent",
            typeData,
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

interface ParsedSubagent {
    requiredMissing: boolean;
    excludedSource: boolean;
    name: string;
    description: string;
    hidden: boolean | undefined;
    sections: Array<{ title: string; content: string }>;
    toolNames: string[] | undefined;
    includeSections: string[] | undefined;
    diagnostics: OperationDiagnostic[];
}

function parseSubagentJson(text: string, path: string): ParsedSubagent {
    const diagnostics: OperationDiagnostic[] = [];
    let root: unknown;
    try {
        root = JSON.parse(text);
    } catch {
        return missingSubagent("Subagent JSON is malformed", path);
    }
    if (!isRecord(root)) return missingSubagent("Subagent JSON root must be an object", path);
    if (containsExcludedSubagentMechanism(root)) return excludedSubagent(path);
    const name = nonBlankString(root.name);
    const description = nonBlankString(root.description);
    const config = isRecord(root.config) ? root.config : null;
    const customAgent = config !== null && isRecord(config.customAgent) ? config.customAgent : null;
    const rawSections = customAgent?.systemPromptSections;
    const sections = Array.isArray(rawSections)
        ? rawSections.flatMap((entry) => {
              if (!isRecord(entry) || typeof entry.title !== "string" || typeof entry.content !== "string") {
                  return [];
              }
              return [{ title: entry.title, content: entry.content }];
          })
        : [];
    if (
        name === undefined ||
        description === undefined ||
        sections.length === 0 ||
        sections.some((item) => item.content.trim() === "")
    ) {
        return missingSubagent("Subagent requires explicit name, description, and non-empty systemPromptSections", path);
    }
    const hidden = typeof root.hidden === "boolean" ? root.hidden : undefined;
    if (Object.hasOwn(root, "hidden") && hidden === undefined) {
        diagnostics.push(invalidSubagentField("hidden", path));
    }
    const toolNames = parseStringArray(customAgent?.toolNames, "toolNames", path, diagnostics);
    const promptConfig = customAgent !== null && isRecord(customAgent.systemPromptConfig) ? customAgent.systemPromptConfig : null;
    if (customAgent !== null && Object.hasOwn(customAgent, "systemPromptConfig") && promptConfig === null) {
        diagnostics.push(invalidSubagentField("systemPromptConfig", path));
    }
    const includeSections = parseStringArray(
        promptConfig?.includeSections,
        "systemPromptConfig.includeSections",
        path,
        diagnostics,
    );
    if (includeSections !== undefined && includeSections.length === 0) {
        diagnostics.push(
            readDiagnostic(
                "antigravity.subagent_empty_context_selection",
                "Explicit empty includeSections cannot be represented as agent-runtime default",
                "invalid_schema",
                "error",
                path,
            ),
        );
    }
    const unknownRoot = unknownRecordKeys(root, ["name", "description", "hidden", "config"]);
    const unknownConfig = config === null ? [] : unknownRecordKeys(config, ["customAgent"]);
    const unknownCustom =
        customAgent === null ? [] : unknownRecordKeys(customAgent, ["systemPromptSections", "toolNames", "systemPromptConfig"]);
    const unknownPromptConfig = promptConfig === null ? [] : unknownRecordKeys(promptConfig, ["includeSections"]);
    for (const [owner, keys] of [
        ["root", unknownRoot],
        ["config", unknownConfig],
        ["config.customAgent", unknownCustom],
        ["config.customAgent.systemPromptConfig", unknownPromptConfig],
    ] as const) {
        if (keys.length > 0) {
            diagnostics.push(
                readDiagnostic(
                    "antigravity.subagent_unknown_behavior_field",
                    `Subagent ${owner} has unsupported fields: ${keys.join(", ")}`,
                    "invalid_schema",
                    "error",
                    path,
                ),
            );
        }
    }
    if (Array.isArray(rawSections) && rawSections.length !== sections.length) {
        diagnostics.push(
            readDiagnostic(
                "antigravity.subagent_section_invalid",
                "Every systemPromptSections item must contain string title and content",
                "invalid_schema",
                "error",
                path,
            ),
        );
    }
    return {
        requiredMissing: false,
        excludedSource: false,
        name,
        description,
        hidden,
        sections,
        toolNames,
        includeSections: includeSections?.length === 0 ? undefined : includeSections,
        diagnostics,
    };
}

function missingSubagent(message: string, path: string): ParsedSubagent {
    return {
        requiredMissing: true,
        excludedSource: false,
        name: "",
        description: "",
        hidden: undefined,
        sections: [],
        toolNames: undefined,
        includeSections: undefined,
        diagnostics: [readDiagnostic("antigravity.subagent_required_content_missing", message, "invalid_schema", "error", path)],
    };
}

function excludedSubagent(path: string): ParsedSubagent {
    return {
        requiredMissing: false,
        excludedSource: true,
        name: "",
        description: "",
        hidden: undefined,
        sections: [],
        toolNames: undefined,
        includeSections: undefined,
        diagnostics: [
            readDiagnostic(
                "antigravity.subagent_excluded_source",
                "Subagent contains hooks, inline MCP configuration, or internal remote execution",
                "unsupported",
                "error",
                path,
            ),
        ],
    };
}

function containsExcludedSubagentMechanism(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const config = isRecord(value.config) ? value.config : null;
    const customAgent = config !== null && isRecord(config.customAgent) ? config.customAgent : null;
    return [value, config, customAgent].some(
        (record) =>
            record !== null &&
            (Object.hasOwn(record, "hooks") ||
                Object.hasOwn(record, "mcpServers") ||
                record.isolation === "remote" ||
                record.executionEnvironment === "remote"),
    );
}

function parseStringArray(value: unknown, field: string, path: string, diagnostics: OperationDiagnostic[]): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
        diagnostics.push(invalidSubagentField(field, path));
        return undefined;
    }
    return uniquePreservingOrder((value as string[]).map((item) => item.trim()));
}

function invalidSubagentField(field: string, path: string): OperationDiagnostic {
    return readDiagnostic(
        "antigravity.subagent_field_invalid",
        `Subagent field ${field} has an invalid type or value`,
        "invalid_schema",
        "error",
        path,
    );
}
