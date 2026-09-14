/** Core-port traversal, source layout resolution, and parse-report ownership. */

import type {
    AdapterAssetSourceCapability,
    AdapterProviderReadInput,
    AssetKind,
    ReadEntryHandle,
    SourceReadObligation,
    SourceRoot,
} from "@oaam/core";
import { traverseSourceRead } from "@oaam/adapter-framework";
import { isFlatSkillEntry, isFolderSkillEntry, isUnderAny, readDiagnostic } from "./antigravity-source-read-foundation";
import type { ScanResult, SourceContext, SourceLayout } from "./antigravity-source-read-model";

export async function scanAntigravityReadObligation(
    input: AdapterProviderReadInput,
    obligation: SourceReadObligation,
    capability: AdapterAssetSourceCapability,
    context: SourceContext,
): Promise<ScanResult> {
    return traverseSourceRead(input, obligation, capability, context, {
        shouldEnterDirectory: (kind, sourceContext, relativePath) =>
            shouldEnterDirectory(kind, sourceContext.layout, relativePath),
        shouldReadFile: (kind, sourceContext, relativePath) => shouldReadFile(kind, sourceContext.layout, relativePath),
        isIndependentSourceEntry: (kind, sourceContext, entry) =>
            kind === "Guidance" ||
            (kind === "Skill" &&
                (isFolderSkillEntry(
                    entry.entryKind === "directory" ? `${entry.relativePath}/SKILL.md` : entry.relativePath,
                    sourceBases(kind, sourceContext.layout),
                ) ||
                    (entry.entryKind === "file" &&
                        isFlatSkillEntry(entry.relativePath, sourceBases(kind, sourceContext.layout))))),
        dispositionId,
        rootEntryKindDiagnostic: (sourceContext, expectedKind) =>
            expectedKind === "directory"
                ? readDiagnostic(
                      "antigravity.source_root_not_directory",
                      "This Antigravity source capability requires a directory root",
                      "invalid_schema",
                      "error",
                      sourceContext.root.path,
                  )
                : readDiagnostic(
                      "antigravity.source_root_not_file",
                      "This Antigravity source capability requires a file root",
                      "invalid_schema",
                      "error",
                      sourceContext.root.path,
                  ),
        mechanismNotCallableDiagnostic: (sourceContext) =>
            readDiagnostic(
                "antigravity.source_path_mechanism_not_callable",
                "This Antigravity source path mechanism is not callable for the selected root",
                "invalid_schema",
                "error",
                sourceContext.root.path,
            ),
    });
}

export function resolveSourceContext(
    input: AdapterProviderReadInput,
    root: SourceRoot,
    capability: AdapterAssetSourceCapability,
): SourceContext | null {
    const selector = input.target.sourceSelector;
    if (selector.selectorKind === "user_selected_root") {
        return {
            root,
            scope: selector.binding.assetScope,
            projectRootPath: selector.binding.projectRootPath,
            layout: "external",
        };
    }
    if (root.sourceDomain === "project_root" && root.rootRole === "project_actual") {
        return { root, scope: "project", projectRootPath: root.path, layout: "project" };
    }
    if (root.sourceDomain === "external_managed") return null;
    if (root.rootRole === "config") {
        return { root, scope: "global", projectRootPath: "", layout: "config" };
    }
    if (root.rootRole === "source" && capability.assetKind === "Skill") {
        return { root, scope: "global", projectRootPath: "", layout: "skill_root" };
    }
    return null;
}

export function sourceBases(kind: AssetKind, layout: SourceLayout): string[] {
    if (layout === "skill_root" || layout === "external") return [""];
    if (layout === "config") {
        if (kind === "Guidance") return [];
        if (kind === "Workflow") return ["config/global_workflows"];
        if (kind === "Skill") return ["config/skills", "skills"];
        if (kind === "Subagent") return ["config/agents"];
        return [];
    }
    if (layout === "project") {
        if (kind === "Rule") return [".agents/rules", ".agent/rules"];
        if (kind === "Workflow") return [".agents/workflows", ".agent/workflows"];
        if (kind === "Skill") return [".agents/skills", ".agent/skills"];
        if (kind === "Subagent") return [".agents/agents", ".agent/agents"];
    }
    return [];
}

function shouldEnterDirectory(kind: AssetKind, layout: SourceLayout, path: string): boolean {
    if (layout === "skill_root" && kind === "Skill") return true;
    const bases = sourceBases(kind, layout);
    if (bases.includes("")) return true;
    return bases.some((base) => path === base || base.startsWith(`${path}/`) || path.startsWith(`${base}/`));
}

function shouldReadFile(kind: AssetKind, layout: SourceLayout, path: string): boolean {
    if (kind === "Guidance") {
        return layout === "project"
            ? path === "AGENTS.md" || path === "GEMINI.md"
            : layout === "config"
              ? path === "GEMINI.md"
              : layout === "external" && path.endsWith(".md");
    }
    if (kind === "Rule" || kind === "Workflow") {
        return path.endsWith(".md") && isUnderAny(path, sourceBases(kind, layout));
    }
    if (kind === "Subagent") {
        return isSubagentSourcePath(path, sourceBases(kind, layout));
    }
    if (kind === "Skill") return isUnderAny(path, sourceBases(kind, layout));
    return false;
}

function isSubagentSourcePath(path: string, bases: string[]): boolean {
    for (const base of bases) {
        const relative = base === "" ? path : path.startsWith(`${base}/`) ? path.slice(base.length + 1) : "";
        if (relative === "") continue;
        const segments = relative.split("/");
        if (
            segments.length === 1 &&
            segments[0] !== ".json" &&
            segments[0] !== ".md" &&
            (segments[0]?.endsWith(".json") === true || segments[0]?.endsWith(".md") === true)
        ) {
            return true;
        }
        if (segments.length === 2 && segments[0] !== "" && (segments[1] === "agent.json" || segments[1] === "agent.md")) {
            return true;
        }
    }
    return false;
}

function dispositionId(handle: ReadEntryHandle): string {
    return `antigravity-disposition:${handle.readEntryHandleId}`;
}
