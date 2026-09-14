/** Claude Code Subagent candidate builder. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic, SubagentTypeDataV2, VersionFileInput } from "@oaam/core";
import { frontmatterString, parseClaudeFrontmatter } from "./claudecode-frontmatter";
import {
    CLAUDECODE_COLOR_DIALECT,
    CLAUDECODE_EFFORT_DIALECT,
    CLAUDECODE_MODEL_DIALECT,
    CLAUDECODE_TURN_LIMIT_DIALECT,
    claudeAgentToolStrings,
    claudeBooleanFrontmatter,
    claudeOptionalString,
    claudePositiveInt,
    claudeStringList,
    effortTier,
    isNestedAgentSelector,
    memoryPolicy,
    modelTier,
    permissionPolicy,
    selectorTier,
    toolSelectors,
} from "./claudecode-source-read-fields";
import {
    candidateBase,
    candidateIdFor,
    compareText,
    compareVersionFile,
    frontmatterDiagnostics,
    metadataOrigins,
    nonBlank,
    parseSlashCommandReferences,
    readDiagnostic,
    rejectNonUtf8Declaration,
    separateNative,
    sourceEvidence,
    uniquePreservingOrder,
    unknownFieldDiagnostic,
    unknownKeys,
} from "./claudecode-source-read-foundation";
import {
    CLAUDECODE_NATIVE_DIALECTS,
    type CandidateBuildResult,
    type ScanResult,
    type SourceContext,
} from "./claudecode-source-read-model";

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
        const parsed = parseClaudeFrontmatter(file.text);
        if (
            parsed.presentKeys.includes("hooks") ||
            parsed.presentKeys.includes("mcpServers") ||
            frontmatterString(parsed, "isolation") === "remote"
        ) {
            scan.ignoreRecord(file, "excluded_subagent_source");
            ignoredSource = true;
            diagnostics.push(
                readDiagnostic(
                    "claudecode.subagent_excluded_source",
                    "Subagent contains hooks, inline MCP configuration, or internal remote isolation",
                    "unsupported",
                    "error",
                    file.relativePath,
                ),
            );
            continue;
        }
        const candidateDiagnostics = frontmatterDiagnostics(parsed, file.relativePath);
        const name = nonBlank(claudeOptionalString(parsed, "name", candidateDiagnostics, file.relativePath, "Subagent"));
        const description = nonBlank(
            claudeOptionalString(parsed, "description", candidateDiagnostics, file.relativePath, "Subagent"),
        );
        if (name === undefined || description === undefined || parsed.body.trim() === "") {
            scan.ignoreRecord(file, "invalid_subagent_source");
            ignoredSource = true;
            diagnostics.push(
                readDiagnostic(
                    "claudecode.subagent_required_content_missing",
                    "Subagent requires explicit non-empty name, description, and instruction body",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            continue;
        }
        const unknown = unknownKeys(parsed, [
            "name",
            "description",
            "tools",
            "disallowedTools",
            "disallowed-tools",
            "skills",
            "permissionMode",
            "memory",
            "background",
            "initialPrompt",
            "model",
            "effort",
            "maxTurns",
            "isolation",
            "color",
        ]);
        if (unknown.length > 0) {
            candidateDiagnostics.push(unknownFieldDiagnostic("Subagent", unknown, file.relativePath));
        }
        const skills = claudeStringList(parsed, "skills", candidateDiagnostics, file.relativePath, "Subagent") ?? [];
        if (skills.length > 0) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.subagent_skill_binding_pending",
                    "Subagent Skill dependencies require accepted Version bindings before import",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const tools = claudeAgentToolStrings(parsed, "tools", candidateDiagnostics, file.relativePath, "Subagent");
        const allowedSelectors = toolSelectors(tools?.filter((item) => item !== "*") ?? []);
        if (allowedSelectors.some((selector) => isNestedAgentSelector(selector.selector))) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.subagent_nested_binding_pending",
                    "Nested user Subagent selectors require accepted Version bindings",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const camelDenied =
            claudeAgentToolStrings(parsed, "disallowedTools", candidateDiagnostics, file.relativePath, "Subagent") ?? [];
        const kebabDenied =
            claudeAgentToolStrings(parsed, "disallowed-tools", candidateDiagnostics, file.relativePath, "Subagent") ?? [];
        if (parsed.presentKeys.includes("disallowedTools") && parsed.presentKeys.includes("disallowed-tools")) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.subagent_disallowed_tools_alias_overlap",
                    "Both Claude Subagent disallowed-tools spellings were present; OAAM conservatively unions them",
                    "conflict",
                    "warning",
                    file.relativePath,
                ),
            );
        }
        const unavailable = toolSelectors(uniquePreservingOrder([...camelDenied, ...kebabDenied])).map((selector) => ({
            mode: "agent_runtime_tool" as const,
            selector,
        }));
        const initialPrompt = nonBlank(
            claudeOptionalString(parsed, "initialPrompt", candidateDiagnostics, file.relativePath, "Subagent"),
        );
        const canonicalFiles: VersionFileInput[] = [
            {
                logicalPath: "instructions.json",
                role: "entry",
                contentKind: "text",
                mediaType: "application/json",
                text: JSON.stringify({
                    schemaVersion: 1,
                    sections: [{ title: "", content: parsed.body }],
                }),
                executable: false,
                references: [],
            },
        ];
        if (initialPrompt !== undefined) {
            canonicalFiles.push({
                logicalPath: "initial-prompt.md",
                role: "resource",
                contentKind: "text",
                mediaType: "text/markdown",
                text: initialPrompt,
                executable: false,
                references: parseSlashCommandReferences(initialPrompt),
            });
        }
        const permission = permissionPolicy(
            claudeOptionalString(parsed, "permissionMode", candidateDiagnostics, file.relativePath, "Subagent"),
            candidateDiagnostics,
            file.relativePath,
        );
        const memory = memoryPolicy(
            claudeOptionalString(parsed, "memory", candidateDiagnostics, file.relativePath, "Subagent"),
            candidateDiagnostics,
            file.relativePath,
        );
        const isolation = claudeOptionalString(parsed, "isolation", candidateDiagnostics, file.relativePath, "Subagent");
        if (isolation !== undefined && isolation !== "worktree") {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.subagent_isolation_invalid",
                    "Unsupported Claude Subagent isolation selector",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const maxTurns = claudePositiveInt(parsed, "maxTurns");
        if (parsed.presentKeys.includes("maxTurns") && maxTurns === undefined) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "claudecode.subagent_turn_limit_invalid",
                    "Subagent maxTurns must be a positive integer",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const typeData: SubagentTypeDataV2 = {
            schemaVersion: 2,
            name,
            description,
            promptContextPolicy: { mode: "agent_runtime_default" },
            tools: {
                availability: {
                    base:
                        tools === undefined || tools.includes("*")
                            ? { mode: "inherit_available" }
                            : tools.length === 0
                              ? { mode: "none" }
                              : {
                                    mode: "allowlist",
                                    allowed: allowedSelectors.map((selector) => ({
                                        mode: "agent_runtime_tool" as const,
                                        selector,
                                    })),
                                },
                    unavailable,
                },
                permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory,
            execution: {
                permission,
                workspaceIsolation: isolation === "worktree" ? { mode: "isolated_worktree" } : { mode: "agent_runtime_default" },
                scheduling:
                    claudeBooleanFrontmatter(parsed, "background", candidateDiagnostics, file.relativePath, "Subagent") === true
                        ? { mode: "always_background" }
                        : { mode: "agent_runtime_default" },
                turnLimit:
                    maxTurns !== undefined && maxTurns > 0 && Number.isInteger(maxTurns)
                        ? {
                              mode: "bounded",
                              dialectId: CLAUDECODE_TURN_LIMIT_DIALECT,
                              limit: maxTurns,
                          }
                        : { mode: "agent_runtime_default" },
                model: selectorTier(
                    claudeOptionalString(parsed, "model", candidateDiagnostics, file.relativePath, "Subagent"),
                    CLAUDECODE_MODEL_DIALECT,
                    modelTier,
                ),
                effort: selectorTier(
                    claudeOptionalString(parsed, "effort", candidateDiagnostics, file.relativePath, "Subagent"),
                    CLAUDECODE_EFFORT_DIALECT,
                    effortTier,
                ),
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
            directInvocation:
                initialPrompt === undefined
                    ? { mode: "agent_runtime_default" }
                    : {
                          mode: "user_selectable",
                          initialPrompt: {
                              mode: "resource",
                              logicalPath: "initial-prompt.md",
                              dialectId: "claudecode-initial-prompt-v1",
                          },
                      },
            presentation: {
                listing: "agent_runtime_default",
                color: (() => {
                    const color = nonBlank(
                        claudeOptionalString(parsed, "color", candidateDiagnostics, file.relativePath, "Subagent"),
                    );
                    return color === undefined
                        ? { mode: "agent_runtime_default" as const }
                        : {
                              mode: "selected" as const,
                              dialectId: CLAUDECODE_COLOR_DIALECT,
                              selector: color,
                          };
                })(),
            },
        };
        const complete =
            parsed.hasFrontmatter && parsed.closed && candidateDiagnostics.every((item) => item.severity !== "error");
        const candidateId = candidateIdFor("Subagent", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: name,
            displayDescription: description,
            files: canonicalFiles.sort(compareVersionFile),
            nativeRepresentation: separateNative(CLAUDECODE_NATIVE_DIALECTS.subagent, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: canonicalFiles
                .map((item) => ({
                    logicalPath: item.logicalPath,
                    observedReadEntryIds: [file.observedReadEntryId],
                }))
                .sort((left, right) => compareText(left.logicalPath, right.logicalPath)),
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
            sourceEvidence: sourceEvidence(scan, file, "frontmatter"),
            diagnostics: candidateDiagnostics,
            kind: "Subagent",
            typeData,
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}
