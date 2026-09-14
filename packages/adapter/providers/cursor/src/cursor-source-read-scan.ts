/** Bounded Cursor project traversal through Core read ports. */

import { isDirectSourceDirectoryEntry, traverseSourceRead } from "@oaam/adapter-framework";
import type { AdapterAssetSourceCapability, AdapterProviderReadInput, ReadEntryHandle, SourceReadObligation } from "@oaam/core";
import { readDiagnostic } from "./cursor-source-read-foundation";
import { cursorSkillBases } from "./cursor-source-read-foundation";
import type { CursorScanResult, CursorSourceContext } from "./cursor-source-read-model";

export function scanCursorReadObligation(
    input: AdapterProviderReadInput,
    obligation: SourceReadObligation,
    capability: AdapterAssetSourceCapability,
    context: CursorSourceContext,
): Promise<CursorScanResult> {
    const unreadableRelativePaths: string[] = [];
    const unreadableDirectoryPaths: string[] = [];
    return traverseSourceRead(
        input,
        obligation,
        capability,
        context,
        {
            ...CURSOR_SOURCE_TRAVERSAL,
            onFileReadFailure: (relativePath) => unreadableRelativePaths.push(relativePath),
            onDirectoryReadFailure: (relativePath) => unreadableDirectoryPaths.push(relativePath),
        },
        { unreadableRelativePaths, unreadableDirectoryPaths },
    );
}

export const CURSOR_SOURCE_TRAVERSAL = {
    shouldEnterDirectory: (
        kind: AdapterAssetSourceCapability["assetKind"],
        context: CursorSourceContext,
        relativePath: string,
    ) => {
        if (kind === "Skill") return shouldEnterSkill(context.layout, relativePath);
        if (kind === "Subagent") {
            return (
                context.layout === "project" &&
                (relativePath === ".cursor" ||
                    relativePath === ".cursor/agents" ||
                    (relativePath.startsWith(".cursor/agents/") && commandDepth(".cursor/agents", relativePath) <= 10))
            );
        }
        if (kind === "Rule") {
            return relativePath === ".cursor" || relativePath === ".cursor/rules" || relativePath.startsWith(".cursor/rules/");
        }
        if (kind !== "Workflow") return false;
        const base = context.layout === "config" ? "commands" : ".cursor/commands";
        if (relativePath === (context.layout === "config" ? "commands" : ".cursor")) return true;
        if (relativePath === base) return true;
        return (
            context.agentRuntimeId === "CURSOR_APP" &&
            relativePath.startsWith(`${base}/`) &&
            commandDepth(base, relativePath) <= 10
        );
    },
    shouldReadFile: (kind: AdapterAssetSourceCapability["assetKind"], context: CursorSourceContext, relativePath: string) => {
        if (kind === "Skill") return shouldReadSkill(context.layout, relativePath);
        if (kind === "Subagent") {
            if (!context.ownsSharedPhysicalSource || context.layout !== "project") return false;
            if (!relativePath.startsWith(".cursor/agents/")) return false;
            const subagentPath = relativePath.slice(".cursor/agents/".length);
            return (
                subagentPath !== "" &&
                !subagentPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..") &&
                commandDepth(".cursor/agents", relativePath) <= 10 &&
                /\.(md|mdc|markdown)$/u.test(subagentPath)
            );
        }
        if (kind === "Guidance") {
            return (
                context.ownsSharedPhysicalSource &&
                ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".cursorrules"].includes(relativePath)
            );
        }
        if (kind === "Rule") {
            return (
                context.ownsSharedPhysicalSource &&
                relativePath.startsWith(".cursor/rules/") &&
                relativePath.endsWith(".mdc") &&
                relativePath !== ".cursor/rules/.mdc"
            );
        }
        if (kind !== "Workflow") return false;
        const base = context.layout === "config" ? "commands" : ".cursor/commands";
        if (!relativePath.startsWith(`${base}/`)) return false;
        const commandPath = relativePath.slice(base.length + 1);
        if (commandPath === "" || commandPath.split("/").some((segment) => segment === "")) return false;
        if (context.agentRuntimeId === "CURSOR_AGENT_CLI") {
            return (
                context.ownsSharedPhysicalSource &&
                !commandPath.includes("/") &&
                commandPath.endsWith(".md") &&
                commandPath !== ".md"
            );
        }
        if (!commandPath.includes("/") && commandPath.endsWith(".md") && !context.ownsSharedPhysicalSource) return false;
        return (
            context.agentRuntimeId === "CURSOR_APP" &&
            commandDepth(base, relativePath) <= 10 &&
            (commandPath.endsWith(".md") || commandPath.endsWith(".txt")) &&
            commandPath !== ".md" &&
            commandPath !== ".txt"
        );
    },
    isIndependentSourceEntry: (
        kind: AdapterAssetSourceCapability["assetKind"],
        sourceContext: CursorSourceContext,
        entry: ReadEntryHandle,
    ) =>
        kind === "Guidance" ||
        (kind === "Skill" &&
            (isDirectSourceDirectoryEntry(entry, cursorSkillBases(sourceContext.layout)) ||
                (entry.entryKind === "file" &&
                    entry.relativePath.endsWith("/SKILL.md") &&
                    isDirectSourceDirectoryEntry(
                        { ...entry, entryKind: "directory", relativePath: entry.relativePath.slice(0, -"/SKILL.md".length) },
                        cursorSkillBases(sourceContext.layout),
                    )))),
    dispositionId: (handle: { readEntryHandleId: string }) => `cursor-disposition:${handle.readEntryHandleId}`,
    rootEntryKindDiagnostic: (sourceContext: CursorSourceContext, expectedKind: "file" | "directory") =>
        readDiagnostic(
            expectedKind === "directory" ? "cursor.source_root_not_directory" : "cursor.source_root_not_file",
            `Cursor source capability requires a ${expectedKind} root`,
            "invalid_schema",
            "error",
            sourceContext.root.path,
        ),
    mechanismNotCallableDiagnostic: (sourceContext: CursorSourceContext) =>
        readDiagnostic(
            "cursor.source_path_mechanism_not_callable",
            "This Cursor source path mechanism is not callable for the selected root",
            "invalid_schema",
            "error",
            sourceContext.root.path,
        ),
};

function commandDepth(base: string, relativePath: string): number {
    const suffix = relativePath === base ? "" : relativePath.slice(base.length + 1);
    return suffix === "" ? 0 : Math.max(0, suffix.split("/").length - 1);
}

function shouldEnterSkill(layout: CursorSourceContext["layout"], relativePath: string): boolean {
    return cursorSkillBases(layout).some((base) => {
        if (base !== "" && (base === relativePath || base.startsWith(`${relativePath}/`))) return true;
        const relative =
            base === "" ? relativePath : relativePath.startsWith(`${base}/`) ? relativePath.slice(base.length + 1) : "";
        const folder = relative.split("/")[0];
        return relative !== "" && folder !== "" && folder !== ".system";
    });
}

function shouldReadSkill(layout: CursorSourceContext["layout"], relativePath: string): boolean {
    return cursorSkillBases(layout).some((base) => {
        const relative =
            base === "" ? relativePath : relativePath.startsWith(`${base}/`) ? relativePath.slice(base.length + 1) : "";
        const segments = relative.split("/");
        return segments.length >= 2 && segments[0] !== "" && segments[0] !== ".system";
    });
}
