/** Codex custom-agent TOML candidate builder. */

import type {
    AdapterExtractedAssetCandidate,
    OperationDiagnostic,
    SubagentInstructionEntryV1,
    SubagentTypeDataV2,
} from "@oaam/core";
import { parseCodexAgentToml } from "./codex-agent-toml";
import {
    candidateBase,
    candidateIdFor,
    compareText,
    metadataOrigins,
    readDiagnostic,
    separateNative,
    sourceEvidence,
} from "./codex-source-read-foundation";
import {
    CODEX_EFFORT_DIALECT,
    CODEX_MODEL_DIALECT,
    CODEX_NATIVE_DIALECTS,
    type CodexScanResult,
    type CodexSourceContext,
} from "./codex-source-read-model";

export function buildSubagentCandidates(context: CodexSourceContext, scan: CodexScanResult) {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const prepared: Array<{
        candidate: AdapterExtractedAssetCandidate;
        file: CodexScanResult["files"][number];
        name: string;
    }> = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const relativePath of scan.unreadableRelativePaths.filter((path) => isAgentPath(path, context.layout))) {
        diagnostics.push(
            readDiagnostic(
                "codex.subagent_source_unreadable",
                "Codex custom-agent TOML exists but could not be read",
                "partial",
                "error",
                relativePath,
            ),
        );
        ignoredSource = true;
    }

    for (const file of scan.files.filter((item) => isAgentPath(item.relativePath, context.layout))) {
        if (file.text === null) {
            scan.ignoreRecord(file, "subagent_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "codex.subagent_source_not_utf8",
                    "Codex custom-agent TOML must be valid UTF-8",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }

        const parsed = parseCodexAgentToml(file.text, file.relativePath);
        if (parsed.rejected) {
            scan.ignoreRecord(file, "subagent_executable_source");
            diagnostics.push(...parsed.diagnostics);
            ignoredSource = true;
            continue;
        }

        if (parsed.name === undefined || parsed.description === undefined || parsed.developerInstructions === undefined) {
            scan.ignoreRecord(file, "invalid_subagent_source");
            diagnostics.push(...parsed.diagnostics);
            ignoredSource = true;
            continue;
        }

        const name = parsed.name;
        const description = parsed.description;
        const instruction: SubagentInstructionEntryV1 = {
            schemaVersion: 1,
            // The TOML key names one undivided prompt; it does not own a portable section title.
            sections: [{ title: "", content: parsed.developerInstructions }],
        };
        const typeData: SubagentTypeDataV2 = {
            schemaVersion: 2,
            name,
            description,
            promptContextPolicy: { mode: "agent_runtime_default" },
            tools: {
                availability: { base: { mode: "inherit_available" }, unavailable: [] },
                permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission: { mode: "inherit" },
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling: { mode: "agent_runtime_default" },
                turnLimit: { mode: "agent_runtime_default" },
                model: selector(parsed.model, CODEX_MODEL_DIALECT),
                effort: selector(parsed.effort, CODEX_EFFORT_DIALECT),
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
            directInvocation: { mode: "delegated_only" },
            presentation: {
                listing: "agent_runtime_default",
                color: { mode: "agent_runtime_default" },
            },
        };
        const complete = parsed.diagnostics.every((item) => item.severity !== "error");
        const logicalPath = "instructions.json";
        const candidateId = candidateIdFor("Subagent", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            scopePath: "",
            displayName: name,
            displayDescription: description,
            files: [
                {
                    logicalPath,
                    role: "entry",
                    contentKind: "text",
                    mediaType: "application/json",
                    text: JSON.stringify(instruction),
                    executable: false,
                    references: [],
                },
            ],
            nativeRepresentation: separateNative(CODEX_NATIVE_DIALECTS.subagent, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [{ logicalPath, observedReadEntryIds: [file.observedReadEntryId] }],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
            sourceEvidence: sourceEvidence(scan, file, "codex_custom_agent_toml"),
            diagnostics: parsed.diagnostics.sort((left, right) => compareText(left.code, right.code)),
            kind: "Subagent",
            typeData,
        };
        prepared.push({ candidate, file, name });
    }
    const nameCounts = new Map<string, number>();
    for (const item of prepared) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
    for (const item of prepared) {
        if ((nameCounts.get(item.name) ?? 0) > 1) {
            scan.ignoreRecord(item.file, "duplicate_subagent_name");
            diagnostics.push(
                readDiagnostic(
                    "codex.subagent_name_duplicate",
                    "Multiple Codex custom-agent files in one source root declare the same agent name",
                    "invalid_schema",
                    "error",
                    item.file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        scan.attachCandidate(item.candidate.candidateId, [item.file]);
        candidates.push(item.candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

function selector(
    value: string | undefined,
    dialectId: string,
): SubagentTypeDataV2["execution"]["model"] | SubagentTypeDataV2["execution"]["effort"] {
    return value === undefined ? { mode: "inherit" } : { mode: "selected", dialectId, selector: value, relativeTier: -1 };
}

function isAgentPath(path: string, layout: CodexSourceContext["layout"]): boolean {
    const segments = path.split("/");
    if (layout === "config") return segments.length === 2 && segments[0] === "agents" && path.endsWith(".toml");
    return (
        layout === "project" &&
        segments.length === 3 &&
        segments[0] === ".codex" &&
        segments[1] === "agents" &&
        path.endsWith(".toml")
    );
}
