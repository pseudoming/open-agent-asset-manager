/** OpenCode Subagent candidate builder and permission-rule mapping. */

import type {
    AdapterExtractedAssetCandidate,
    OperationDiagnostic,
    SubagentToolPermissionRuleV2,
    SubagentTypeDataV2,
    VersionFileInput,
} from "@oaam/core";
import { frontmatterMap, parseOpencodeFrontmatter, type ParsedOpencodeFrontmatter } from "./opencode-frontmatter";
import {
    candidateBase,
    candidateIdFor,
    declarationName,
    metadataOrigins,
    nonBlank,
    readDiagnostic,
    rejectNonUtf8,
    separateNative,
    sourceEvidence,
} from "./opencode-source-read-foundation";
import {
    frontmatterDiagnostics,
    isOpencodeColor,
    legacyToolPermissionSelector,
    optionalBoolean,
    optionalNumber,
    optionalString,
    positiveInt,
    selectorTier,
    toolSelector,
    typeMismatchDiagnostic,
    unknownKeys,
} from "./opencode-source-read-fields";
import { isManifestPath, reportManifestFiles } from "./opencode-source-read-jsonc";
import {
    COLOR_DIALECT,
    CURRENT_AGENT_FRONTMATTER_KEYS,
    MODEL_DIALECT,
    OPENCODE_NATIVE_DIALECTS,
    TURN_LIMIT_DIALECT,
    VARIANT_DIALECT,
    type CandidateBuildResult,
    type ScanResult,
    type SourceContext,
} from "./opencode-source-read-model";

export function buildSubagentCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = reportManifestFiles(scan, "Subagent", diagnostics);
    for (const file of scan.files.filter((item) => !isManifestPath(item.relativePath, context.layout))) {
        if (file.text === null) {
            rejectNonUtf8(scan, file, "Subagent", diagnostics);
            ignoredSource = true;
            continue;
        }
        const parsed = parseOpencodeFrontmatter(file.text);
        if (
            parsed.presentKeys.includes("hooks") ||
            parsed.presentKeys.includes("mcp") ||
            parsed.presentKeys.includes("mcpServers") ||
            parsed.values.isolation === "remote"
        ) {
            scan.ignoreRecord(file, "excluded_subagent_source");
            diagnostics.push(
                readDiagnostic(
                    "opencode.subagent_excluded_source",
                    "Subagent contains hooks, inline MCP configuration, or internal remote isolation",
                    "unsupported",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const candidateDiagnostics = frontmatterDiagnostics(parsed, file.relativePath);
        const unknown = unknownKeys(parsed, [
            "name",
            "model",
            "variant",
            "temperature",
            "top_p",
            "prompt",
            "tools",
            "disable",
            "description",
            "mode",
            "hidden",
            "options",
            "color",
            "steps",
            "maxSteps",
            "permission",
            "request",
            "system",
            "disabled",
            "permissions",
        ]);
        if (unknown.length > 0) {
            candidateDiagnostics.push(privateFrontmatterDiagnostic(unknown, file.relativePath));
        }
        if (parsed.presentKeys.includes("options")) {
            const options = frontmatterMap(parsed, "options");
            candidateDiagnostics.push(
                options === undefined
                    ? typeMismatchDiagnostic("Subagent", "options", file.relativePath)
                    : privateFrontmatterDiagnostic(["options"], file.relativePath),
            );
        }
        const usesLegacySchema = parsed.presentKeys.some((key) => !CURRENT_AGENT_FRONTMATTER_KEYS.has(key));
        if (parsed.presentKeys.includes("request")) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "opencode.subagent_request_unowned",
                    "Subagent provider request headers/body have no lossless canonical owner",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        if (parsed.presentKeys.includes("permissions")) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "opencode.subagent_permissions_shape_unsupported",
                    "Current OpenCode permission rulesets cannot be losslessly represented by this source reader",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const legacyDisabled = optionalBoolean(parsed, "disable", candidateDiagnostics, file.relativePath, "Subagent");
        const currentDisabled = optionalBoolean(parsed, "disabled", candidateDiagnostics, file.relativePath, "Subagent");
        for (const key of ["system", "disabled"] as const) {
            if (usesLegacySchema && parsed.presentKeys.includes(key)) {
                candidateDiagnostics.push(
                    readDiagnostic(
                        "opencode.subagent_current_field_in_legacy_document",
                        `Subagent field ${key} is migrated into provider request data when legacy fields are present`,
                        "invalid_schema",
                        "error",
                        file.relativePath,
                    ),
                );
            }
        }
        const disabled = usesLegacySchema ? legacyDisabled : currentDisabled;
        const mode = optionalString(parsed, "mode", candidateDiagnostics, file.relativePath, "Subagent") ?? "all";
        if (disabled === true || mode === "primary") {
            scan.ignoreRecord(file, disabled === true ? "disabled_agent" : "primary_agent_not_subagent");
            diagnostics.push(
                readDiagnostic(
                    disabled === true ? "opencode.subagent_disabled" : "opencode.primary_agent_not_collected",
                    disabled === true
                        ? "Disabled opencode agent declaration was not collected"
                        : "Primary-only opencode agent is outside the OAAM Subagent asset boundary",
                    "unsupported",
                    "warning",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        if (mode !== "subagent" && mode !== "all") {
            candidateDiagnostics.push(
                readDiagnostic(
                    "opencode.subagent_mode_invalid",
                    "Subagent mode must be subagent, all, or omitted",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const body = parsed.hasFrontmatter && parsed.closed ? parsed.body : file.text;
        const name = declarationName(file.relativePath, [".opencode/agent/", ".opencode/agents/", "agent/", "agents/"]);
        if (parsed.presentKeys.includes("name")) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "opencode.subagent_frontmatter_name_ignored",
                    "OpenCode derives standalone agent identity from its relative filename; frontmatter name is not authoritative",
                    "unsupported",
                    "warning",
                    file.relativePath,
                ),
            );
        }
        if (nonBlank(name) === undefined) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "opencode.subagent_name_missing",
                    "OpenCode Subagent requires a non-empty name or declaration filename",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const description = nonBlank(optionalString(parsed, "description", candidateDiagnostics, file.relativePath, "Subagent"));
        if (description === undefined) {
            scan.ignoreRecord(file, "subagent_description_missing");
            diagnostics.push(
                readDiagnostic(
                    "opencode.subagent_description_missing",
                    "OpenCode Subagent requires a non-empty description",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const toolRules = subagentToolRules(parsed, candidateDiagnostics, file.relativePath);
        const steps = positiveInt(
            optionalNumber(parsed, "steps", candidateDiagnostics, file.relativePath, "Subagent") ??
                optionalNumber(parsed, "maxSteps", candidateDiagnostics, file.relativePath, "Subagent"),
        );
        if ((parsed.presentKeys.includes("steps") || parsed.presentKeys.includes("maxSteps")) && steps === undefined) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "opencode.subagent_steps_invalid",
                    "Subagent steps/maxSteps must be a positive integer",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const temperature = optionalNumber(parsed, "temperature", candidateDiagnostics, file.relativePath, "Subagent");
        const topP = optionalNumber(parsed, "top_p", candidateDiagnostics, file.relativePath, "Subagent");
        const color = nonBlank(optionalString(parsed, "color", candidateDiagnostics, file.relativePath, "Subagent"));
        if (color !== undefined && !isOpencodeColor(color)) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "opencode.subagent_color_invalid",
                    "Subagent color must be an OpenCode theme color or a six-digit hex color",
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
                availability: { base: { mode: "inherit_available" }, unavailable: [] },
                permission: { rules: toolRules, otherwise: "inherit_agent_runtime_policy" },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission: { mode: "inherit" },
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling: { mode: "agent_runtime_default" },
                turnLimit:
                    steps === undefined
                        ? { mode: "agent_runtime_default" }
                        : { mode: "bounded", dialectId: TURN_LIMIT_DIALECT, limit: steps },
                model: selectorTier(
                    optionalString(parsed, "model", candidateDiagnostics, file.relativePath, "Subagent"),
                    MODEL_DIALECT,
                ),
                effort: selectorTier(
                    optionalString(parsed, "variant", candidateDiagnostics, file.relativePath, "Subagent"),
                    VARIANT_DIALECT,
                ),
                sampling: {
                    temperature:
                        temperature === undefined ? { mode: "agent_runtime_default" } : { mode: "selected", value: temperature },
                    topP: topP === undefined ? { mode: "agent_runtime_default" } : { mode: "selected", value: topP },
                },
            },
            directInvocation:
                mode === "subagent" ? { mode: "delegated_only" } : { mode: "user_selectable", initialPrompt: { mode: "none" } },
            presentation: {
                listing:
                    optionalBoolean(parsed, "hidden", candidateDiagnostics, file.relativePath, "Subagent") === true
                        ? "hidden"
                        : "agent_runtime_default",
                color:
                    color === undefined
                        ? { mode: "agent_runtime_default" }
                        : { mode: "selected", dialectId: COLOR_DIALECT, selector: color },
            },
        };
        const complete = body.trim() !== "" && candidateDiagnostics.every((item) => item.severity !== "error");
        const canonicalFiles: VersionFileInput[] = [
            {
                logicalPath: "instructions.json",
                role: "entry",
                contentKind: "text",
                mediaType: "application/json",
                text: JSON.stringify({
                    schemaVersion: 1,
                    sections: [{ title: "", content: body.trim() }],
                }),
                executable: false,
                references: [],
            },
        ];
        const candidateId = candidateIdFor("Subagent", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: name,
            displayDescription: description,
            files: canonicalFiles,
            nativeRepresentation: separateNative(OPENCODE_NATIVE_DIALECTS.subagent, [file]),
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
            sourceEvidence: sourceEvidence(scan, file, "opencode_subagent_markdown"),
            diagnostics: candidateDiagnostics,
            kind: "Subagent",
            typeData,
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

function privateFrontmatterDiagnostic(keys: string[], path: string): OperationDiagnostic {
    return readDiagnostic(
        "opencode.subagent_private_frontmatter_preserved",
        `OpenCode Subagent private frontmatter is preserved for same-runtime restoration but has no portable owner: ${keys.join(", ")}`,
        "unsupported",
        "warning",
        path,
    );
}

function subagentToolRules(
    parsed: ParsedOpencodeFrontmatter,
    diagnostics: OperationDiagnostic[],
    path: string,
): SubagentToolPermissionRuleV2[] {
    const merged = new Map<string, "preapproved" | "ask" | "deny">();
    const tools = frontmatterMap(parsed, "tools");
    if (parsed.presentKeys.includes("tools") && tools === undefined) {
        diagnostics.push(typeMismatchDiagnostic("Subagent", "tools", path));
    } else {
        for (const [selector, raw] of Object.entries(tools ?? {})) {
            if (typeof raw !== "boolean") {
                diagnostics.push(typeMismatchDiagnostic("Subagent", `tools.${selector}`, path));
                continue;
            }
            merged.set(legacyToolPermissionSelector(selector), raw ? "preapproved" : "deny");
        }
    }
    const permission = frontmatterMap(parsed, "permission");
    if (parsed.presentKeys.includes("permission") && permission === undefined) {
        diagnostics.push(
            readDiagnostic(
                "opencode.subagent_permission_shape_unsupported",
                "Nested/pattern opencode permission rules cannot be represented by the bounded frontmatter parser",
                "invalid_schema",
                "error",
                path,
            ),
        );
    } else {
        for (const [selector, raw] of Object.entries(permission ?? {})) {
            if (raw !== "allow" && raw !== "ask" && raw !== "deny") {
                diagnostics.push(typeMismatchDiagnostic("Subagent", `permission.${selector}`, path));
                continue;
            }
            merged.set(selector, raw === "allow" ? "preapproved" : raw);
        }
    }
    return [...merged.entries()].map(([selector, action]) => ({
        selector: { mode: "agent_runtime_tool", selector: toolSelector(selector) },
        action,
    }));
}
