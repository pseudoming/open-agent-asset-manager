/** Bounded Codex source traversal delegated to Adapter Framework. */

import { traverseSourceRead } from "@oaam/adapter-framework";
import type { AdapterProviderReadInput, SourceReadObligation } from "@oaam/core";
import type { AdapterAssetSourceCapability } from "@oaam/core";
import { basename, codexSkillFolderForEntry, readDiagnostic } from "./codex-source-read-foundation";
import type { CodexScanResult, CodexSourceContext } from "./codex-source-read-model";

export async function scanCodexReadObligation(
    input: AdapterProviderReadInput,
    obligation: SourceReadObligation,
    capability: AdapterAssetSourceCapability,
    context: CodexSourceContext,
): Promise<CodexScanResult> {
    const unreadableRelativePaths: string[] = [];
    return traverseSourceRead(
        input,
        obligation,
        capability,
        context,
        {
            shouldEnterDirectory: (kind, sourceContext, relativePath) => shouldEnter(kind, sourceContext, relativePath),
            shouldReadFile: (kind, sourceContext, relativePath) => shouldRead(kind, sourceContext, relativePath),
            isIndependentSourceEntry: (kind, sourceContext, entry) => {
                if (kind === "Guidance") return true;
                if (kind !== "Skill") return false;
                const layout = sourceContext.layout === "skill_root" ? "skill_root" : "project";
                return (
                    codexSkillFolderForEntry(
                        entry.entryKind === "directory" ? `${entry.relativePath}/SKILL.md` : entry.relativePath,
                        layout,
                    ) !== null
                );
            },
            dispositionId: (handle) => `codex-disposition:${handle.readEntryHandleId}`,
            rootEntryKindDiagnostic: (sourceContext, expectedKind) =>
                readDiagnostic(
                    expectedKind === "directory" ? "codex.source_root_not_directory" : "codex.source_root_not_file",
                    expectedKind === "directory"
                        ? "Codex source roots must be directories"
                        : "The selected Codex source capability requires a file root",
                    "invalid_schema",
                    "error",
                    sourceContext.root.path,
                ),
            mechanismNotCallableDiagnostic: (sourceContext) =>
                readDiagnostic(
                    "codex.source_path_mechanism_not_callable",
                    "Codex source path mechanism is not callable for the selected root",
                    "invalid_schema",
                    "error",
                    sourceContext.root.path,
                ),
            onFileReadFailure: (relativePath) => unreadableRelativePaths.push(relativePath),
        },
        { unreadableRelativePaths },
    );
}

function shouldEnter(kind: string, context: CodexSourceContext, relativePath: string): boolean {
    if (kind === "Guidance") return context.layout === "project";
    if (kind === "Memory") return context.layout === "memory" && relativePath === "memories";
    if (kind === "Subagent") return shouldEnterSubagent(context, relativePath);
    if (kind === "Workflow") return context.layout === "config" && relativePath === "prompts";
    if (kind !== "Skill" || context.layout === "config") return false;
    const segments = relativePath.split("/");
    if (context.layout === "skill_root") return segments[0] !== "" && segments[0] !== ".system";
    if (segments[0] !== ".agents" && segments[0] !== ".codex") return false;
    if (segments.length === 1) return true;
    if (segments[1] !== "skills") return false;
    return segments.length < 3 || (segments[2] !== "" && segments[2] !== ".system");
}

function shouldRead(kind: string, context: CodexSourceContext, relativePath: string): boolean {
    if (kind === "Guidance") return guidanceFilenames(context).includes(basename(relativePath));
    if (kind === "Memory") {
        return (
            context.layout === "memory" &&
            (relativePath === "memories/MEMORY.md" || relativePath === "memories/memory_summary.md")
        );
    }
    if (kind === "Subagent") return isDirectSubagentFile(context, relativePath);
    if (kind === "Workflow") {
        const segments = relativePath.split("/");
        return context.layout === "config" && segments.length === 2 && segments[0] === "prompts" && relativePath.endsWith(".md");
    }
    if (kind !== "Skill" || context.layout === "config") return false;
    const segments = relativePath.split("/");
    if (context.layout === "skill_root") return segments.length >= 2 && segments[0] !== ".system";
    return (
        segments.length >= 4 &&
        (segments[0] === ".agents" || segments[0] === ".codex") &&
        segments[1] === "skills" &&
        segments[2] !== "" &&
        segments[2] !== ".system"
    );
}

function shouldEnterSubagent(context: CodexSourceContext, relativePath: string): boolean {
    if (context.layout === "config") return relativePath === "agents";
    if (context.layout !== "project") return false;
    return relativePath === ".codex" || relativePath === ".codex/agents";
}

function isDirectSubagentFile(context: CodexSourceContext, relativePath: string): boolean {
    const segments = relativePath.split("/");
    if (!relativePath.endsWith(".toml")) return false;
    if (context.layout === "config") return segments.length === 2 && segments[0] === "agents";
    return context.layout === "project" && segments.length === 3 && segments[0] === ".codex" && segments[1] === "agents";
}

function guidanceFilenames(context: CodexSourceContext): string[] {
    return ["AGENTS.override.md", "AGENTS.md", ...(context.layout === "project" ? context.fallbackFilenames : [])];
}
