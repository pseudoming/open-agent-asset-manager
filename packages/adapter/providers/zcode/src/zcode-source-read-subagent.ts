/** ZCode user/project Subagent Markdown candidate builder. */

import type {
    AdapterExtractedAssetCandidate,
    OperationDiagnostic,
    SubagentInstructionEntryV1,
    SubagentTypeDataV2,
} from "@oaam/core";
import { frontmatterString, parseZcodeSubagentFrontmatter } from "./zcode-frontmatter";
import {
    colorSelection,
    frontmatterDiagnostics,
    modelSelection,
    optionalBoolean,
    optionalString,
    permissionPolicy,
    positiveTurnLimit,
    stringList,
    subagentToolSelectors,
    unknownFieldDiagnostic,
} from "./zcode-source-read-fields";
import {
    candidateBase,
    candidateIdFor,
    metadataOrigins,
    nonBlank,
    readDiagnostic,
    separateNative,
    sourceEvidence,
    textEntry,
} from "./zcode-source-read-foundation";
import { ZCODE_NATIVE_DIALECTS, type ZcodeScanResult, type ZcodeSourceContext } from "./zcode-source-read-model";

const FIELDS = new Set([
    "name",
    "description",
    "color",
    "model",
    "tools",
    "disallowedTools",
    "skills",
    "background",
    "permissionMode",
    "maxTurns",
    "mcpServers",
    "hooks",
]);

export function buildSubagentCandidates(context: ZcodeSourceContext, scan: ZcodeScanResult) {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.text === null) {
            scan.ignoreRecord(file, "subagent_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "zcode.subagent_not_utf8",
                    "ZCode Subagent declarations must be valid UTF-8",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const parsed = parseZcodeSubagentFrontmatter(file.text);
        if (parsed.presentKeys.includes("hooks") || parsed.presentKeys.includes("mcpServers")) {
            scan.ignoreRecord(file, "excluded_subagent_source");
            diagnostics.push(
                readDiagnostic(
                    "zcode.subagent_executable_authority_rejected",
                    "Subagent hooks or inline MCP servers are outside the ordinary Subagent contract",
                    "unsupported",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const candidateDiagnostics = frontmatterDiagnostics(parsed, "Subagent", file.relativePath);
        const name = nonBlank(frontmatterString(parsed, "name"));
        const rawDescription = nonBlank(frontmatterString(parsed, "description"));
        const description = rawDescription?.split("\\n").join("\n");
        const body = parsed.body.trim();
        if (!parsed.hasFrontmatter || !parsed.closed || name === undefined || description === undefined || body === "") {
            scan.ignoreRecord(file, "invalid_subagent_source");
            diagnostics.push(
                ...candidateDiagnostics,
                readDiagnostic(
                    "zcode.subagent_required_content_missing",
                    "ZCode Subagent requires closed frontmatter, non-empty name and description, and a non-empty prompt body",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const unknown = parsed.presentKeys.filter((key) => !FIELDS.has(key));
        if (unknown.length > 0) candidateDiagnostics.push(unknownFieldDiagnostic("Subagent", unknown, file.relativePath));
        const rawTools = stringList(parsed, "tools", candidateDiagnostics, file.relativePath, "Subagent");
        const rawUnavailable = stringList(parsed, "disallowedTools", candidateDiagnostics, file.relativePath, "Subagent") ?? [];
        const allowed = subagentToolSelectors(rawTools ?? []);
        const unavailable = subagentToolSelectors(rawUnavailable).map((selector) => ({
            mode: "agent_runtime_tool" as const,
            selector,
        }));
        const skills = stringList(parsed, "skills", candidateDiagnostics, file.relativePath, "Subagent") ?? [];
        if (skills.length > 0) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "zcode.subagent_skill_binding_pending",
                    "ZCode Subagent Skill dependencies require accepted Version bindings before import",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const background = optionalBoolean(parsed, "background", candidateDiagnostics, file.relativePath, "Subagent");
        const model = optionalString(parsed, "model", candidateDiagnostics, file.relativePath, "Subagent");
        const permissionMode = optionalString(parsed, "permissionMode", candidateDiagnostics, file.relativePath, "Subagent");
        if (context.layout === "project" && permissionMode !== undefined) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "zcode.subagent_project_permission_ignored",
                    "The current ZCode project Subagent loader ignores permissionMode; OAAM preserved the native field and inherited runtime policy",
                    "unsupported",
                    "warning",
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
                        rawTools === undefined || rawTools.length === 0
                            ? { mode: "inherit_available" }
                            : {
                                  mode: "allowlist",
                                  allowed: allowed.map((selector) => ({ mode: "agent_runtime_tool" as const, selector })),
                              },
                    unavailable,
                },
                permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission:
                    context.layout === "project"
                        ? { mode: "inherit" }
                        : permissionPolicy(permissionMode, candidateDiagnostics, file.relativePath),
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling:
                    background === true
                        ? { mode: "always_background" }
                        : background === false
                          ? { mode: "always_foreground" }
                          : { mode: "agent_runtime_default" },
                turnLimit: positiveTurnLimit(parsed, candidateDiagnostics, file.relativePath),
                model: modelSelection(model),
                effort: { mode: "inherit" },
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
            directInvocation: { mode: "delegated_only" },
            presentation: {
                listing: "visible",
                color: colorSelection(
                    optionalString(parsed, "color", candidateDiagnostics, file.relativePath, "Subagent"),
                    candidateDiagnostics,
                    file.relativePath,
                ),
            },
        };
        const instruction: SubagentInstructionEntryV1 = {
            schemaVersion: 1,
            sections: [{ title: "", content: body }],
        };
        const complete = candidateDiagnostics.every((item) => item.severity !== "error");
        const candidateId = candidateIdFor("Subagent", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file),
            scopePath: "",
            displayName: name,
            displayDescription: description,
            files: [textEntry("instructions.json", JSON.stringify(instruction))],
            nativeRepresentation: separateNative(ZCODE_NATIVE_DIALECTS.subagent, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [{ logicalPath: "instructions.json", observedReadEntryIds: [file.observedReadEntryId] }],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
            sourceEvidence: sourceEvidence(scan, file, "zcode_subagent_markdown"),
            diagnostics: candidateDiagnostics,
            kind: "Subagent",
            typeData,
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    markDuplicateIdentities(candidates);
    return { candidates, diagnostics, ignoredSource };
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
                "zcode.subagent_duplicate_identity",
                "Multiple Subagent declarations in this source root use the same name",
                "conflict",
                "error",
                candidate.displayName,
            ),
        );
    }
}
