/** Bounded ZCode source traversal delegated to Adapter Framework. */

import { isDirectSourceDirectoryEntry, traverseSourceRead } from "@oaam/adapter-framework";
import type { AdapterAssetSourceCapability, AdapterProviderReadInput, SourceReadObligation } from "@oaam/core";
import {
    commandBasesForLayout,
    readDiagnostic,
    scriptWorkflowBasesForLayout,
    skillBasesForLayout,
    subagentBasesForLayout,
} from "./zcode-source-read-foundation";
import type { ZcodeScanResult, ZcodeSourceContext } from "./zcode-source-read-model";

export function scanZcodeReadObligation(
    input: AdapterProviderReadInput,
    obligation: SourceReadObligation,
    capability: AdapterAssetSourceCapability,
    context: ZcodeSourceContext,
): Promise<ZcodeScanResult> {
    const unreadableRelativePaths: string[] = [];
    const unreadableDirectoryPaths: string[] = [];
    return traverseSourceRead(
        input,
        obligation,
        capability,
        context,
        {
            shouldEnterDirectory: (kind, sourceContext, relativePath) => {
                if (kind === "Memory") return sourceContext.layout === "memory" && relativePath === "topics";
                if (kind === "Skill") return shouldEnterSkill(sourceContext.layout, relativePath);
                if (kind === "Workflow") {
                    return shouldEnterAny(
                        [...commandBasesForLayout(sourceContext.layout), ...scriptWorkflowBasesForLayout(sourceContext.layout)],
                        relativePath,
                    );
                }
                return kind === "Subagent" && shouldEnterAny(subagentBasesForLayout(sourceContext.layout), relativePath);
            },
            shouldReadFile: (kind, sourceContext, relativePath) =>
                kind === "Memory"
                    ? shouldReadMemory(sourceContext.layout, relativePath)
                    : kind === "Guidance"
                      ? relativePath === "AGENTS.md"
                      : kind === "Skill"
                        ? shouldReadSkill(sourceContext.layout, relativePath)
                        : kind === "Workflow"
                          ? shouldReadWorkflow(sourceContext.layout, relativePath)
                          : kind === "Subagent" && shouldReadSubagent(sourceContext.layout, relativePath),
            isIndependentSourceEntry: (kind, sourceContext, entry) =>
                kind === "Guidance" ||
                (kind === "Skill" &&
                    (isDirectSourceDirectoryEntry(entry, skillBasesForLayout(sourceContext.layout)) ||
                        (entry.entryKind === "file" &&
                            entry.relativePath.endsWith("/SKILL.md") &&
                            isDirectSourceDirectoryEntry(
                                {
                                    ...entry,
                                    entryKind: "directory",
                                    relativePath: entry.relativePath.slice(0, -"/SKILL.md".length),
                                },
                                skillBasesForLayout(sourceContext.layout),
                            )))),
            dispositionId: (handle) => `zcode-disposition:${handle.readEntryHandleId}`,
            rootEntryKindDiagnostic: (sourceContext, expectedKind) =>
                readDiagnostic(
                    expectedKind === "directory" ? "zcode.source_root_not_directory" : "zcode.source_root_not_file",
                    expectedKind === "directory"
                        ? "This ZCode source capability requires a directory root"
                        : "This ZCode source capability requires a file root",
                    "invalid_schema",
                    "error",
                    sourceContext.root.path,
                ),
            mechanismNotCallableDiagnostic: (sourceContext) =>
                readDiagnostic(
                    "zcode.source_path_mechanism_not_callable",
                    "This ZCode source path mechanism is not callable for the selected root",
                    "invalid_schema",
                    "error",
                    sourceContext.root.path,
                ),
            onFileReadFailure: (relativePath) => unreadableRelativePaths.push(relativePath),
            onDirectoryReadFailure: (relativePath) => unreadableDirectoryPaths.push(relativePath),
        },
        { unreadableRelativePaths, unreadableDirectoryPaths },
    );
}

function shouldReadMemory(layout: ZcodeSourceContext["layout"], relativePath: string): boolean {
    if (layout !== "memory") return false;
    if (relativePath === "MEMORY.md") return true;
    const segments = relativePath.split("/");
    return segments.length === 2 && segments[0] === "topics" && (segments[1] ?? "").endsWith(".md");
}

function shouldEnterAny(bases: string[], relativePath: string): boolean {
    return bases.some(
        (base) =>
            base === "" || relativePath === base || base.startsWith(`${relativePath}/`) || relativePath.startsWith(`${base}/`),
    );
}

function shouldReadWorkflow(layout: ZcodeSourceContext["layout"], relativePath: string): boolean {
    return (
        isFileBelowAny(relativePath, commandBasesForLayout(layout), ".md") ||
        isFileBelowAny(relativePath, scriptWorkflowBasesForLayout(layout), ".workflow.js")
    );
}

function shouldReadSubagent(layout: ZcodeSourceContext["layout"], relativePath: string): boolean {
    return (
        isFileBelowAny(relativePath, subagentBasesForLayout(layout), ".md") ||
        isFileBelowAny(relativePath, subagentBasesForLayout(layout), ".markdown")
    );
}

function isFileBelowAny(relativePath: string, bases: string[], suffix: string): boolean {
    if (!relativePath.toLowerCase().endsWith(suffix)) return false;
    return bases.some((base) => base === "" || relativePath.startsWith(`${base}/`));
}

function shouldEnterSkill(layout: ZcodeSourceContext["layout"], relativePath: string): boolean {
    return skillBasesForLayout(layout).some((base) => {
        if (base !== "" && (base === relativePath || base.startsWith(`${relativePath}/`))) return true;
        const relative =
            base === "" ? relativePath : relativePath.startsWith(`${base}/`) ? relativePath.slice(base.length + 1) : "";
        const folder = relative.split("/")[0];
        return relative !== "" && folder !== "" && folder !== ".system";
    });
}

function shouldReadSkill(layout: ZcodeSourceContext["layout"], relativePath: string): boolean {
    return skillBasesForLayout(layout).some((base) => {
        const relative =
            base === "" ? relativePath : relativePath.startsWith(`${base}/`) ? relativePath.slice(base.length + 1) : "";
        const segments = relative.split("/");
        return segments.length >= 2 && segments[0] !== "" && segments[0] !== ".system";
    });
}
