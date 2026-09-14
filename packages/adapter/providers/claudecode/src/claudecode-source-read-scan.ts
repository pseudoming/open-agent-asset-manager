/** Claude Code source-root resolution, traversal, and read-entry accounting. */

import type {
    AdapterAssetSourceCapability,
    AdapterProviderReadInput,
    AssetKind,
    ReadEntryHandle,
    SourceReadObligation,
    SourceRoot,
} from "@oaam/core";
import { traverseSourceRead } from "@oaam/adapter-framework";
import { firstSegment, isUnderAny, readDiagnostic } from "./claudecode-source-read-foundation";
import type { ScanResult, SourceContext } from "./claudecode-source-read-model";

export function resolveSourceContext(input: AdapterProviderReadInput, root: SourceRoot, kind: AssetKind): SourceContext | null {
    const selector = input.target.sourceSelector;
    if (selector.selectorKind === "user_selected_root") {
        return {
            root,
            scope: selector.binding.assetScope,
            projectRootPath: selector.binding.projectRootPath,
            layout: kind === "Memory" ? "memory" : selector.binding.assetScope === "project" ? "project" : "config",
        };
    }
    if (root.sourceDomain === "agent_runtime_private" && root.rootRole === "config") {
        return { root, scope: "global", projectRootPath: "", layout: "config" };
    }
    if (root.sourceDomain === "project_root" && root.rootRole === "project_actual") {
        return { root, scope: "project", projectRootPath: root.path, layout: "project" };
    }
    if (root.sourceDomain === "project_keyed") {
        const projectRootPath = resolveObservedProjectRootPath(input, root);
        if (projectRootPath === null) return null;
        return {
            root,
            scope: "project",
            projectRootPath,
            layout: "memory",
        };
    }
    return null;
}

function resolveObservedProjectRootPath(input: AdapterProviderReadInput, memoryRoot: SourceRoot): string | null {
    const selector = input.target.sourceSelector;
    if (selector.selectorKind !== "probe_roots") return null;

    const observedProjectIds = new Set(
        selector.observation.observedAgentRuntimes
            .filter((agentRuntime) => agentRuntime.sourceRootIds.includes(memoryRoot.sourceRootId))
            .flatMap((agentRuntime) => agentRuntime.observedProjectIds),
    );
    if (observedProjectIds.size !== 1) return null;
    const observedProjectId = [...observedProjectIds][0];
    const project = selector.observation.observedProjects.find((candidate) => candidate.observedProjectId === observedProjectId);
    const primaryWorkspace = project?.workspaces.find((workspace) => workspace.role === "primary");
    const projectRoot = selector.observation.sourceRoots.find(
        (sourceRoot) => sourceRoot.sourceRootId === primaryWorkspace?.sourceRootId,
    );
    return projectRoot?.rootRole === "project_actual" && projectRoot.sourceDomain === "project_root" ? projectRoot.path : null;
}

export async function scanClaudeCodeReadObligation(
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
                isDirectSkillEntry(
                    entry.entryKind === "directory" ? `${entry.relativePath}/SKILL.md` : entry.relativePath,
                    sourceContext.layout,
                )),
        dispositionId,
        rootEntryKindDiagnostic: (sourceContext, expectedKind) =>
            expectedKind === "directory"
                ? readDiagnostic(
                      "claudecode.source_root_not_directory",
                      "Claude Code source roots must be directories",
                      "invalid_schema",
                      "error",
                      sourceContext.root.path,
                  )
                : readDiagnostic(
                      "claudecode.source_root_not_file",
                      "Claude Code source capability requires a file root",
                      "invalid_schema",
                      "error",
                      sourceContext.root.path,
                  ),
        mechanismNotCallableDiagnostic: (sourceContext) =>
            readDiagnostic(
                "claudecode.source_path_mechanism_not_callable",
                "Claude Code source path mechanism is not callable for the selected root",
                "invalid_schema",
                "error",
                sourceContext.root.path,
            ),
    });
}

export function isDirectSkillEntry(path: string, layout: SourceContext["layout"]): boolean {
    if (layout === "memory") return false;
    return sourceBases("Skill", layout).some((base) => {
        if (!path.startsWith(`${base}/`)) return false;
        const relative = path.slice(base.length + 1);
        const segments = relative.split("/");
        return segments.length === 2 && segments[0] !== "" && segments[1] === "SKILL.md";
    });
}

function shouldEnterDirectory(kind: AssetKind, layout: SourceContext["layout"], path: string): boolean {
    if (layout === "memory") return firstSegment(path) !== "team";
    if (kind === "Guidance") return layout === "project" && path === ".claude";
    const bases = sourceBases(kind, layout);
    return bases.some((base) => path === base || base.startsWith(`${path}/`) || path.startsWith(`${base}/`));
}

function shouldReadFile(kind: AssetKind, layout: SourceContext["layout"], path: string): boolean {
    if (layout === "memory") return path.endsWith(".md") && firstSegment(path) !== "team";
    if (kind === "Guidance") {
        return layout === "config"
            ? path === "CLAUDE.md"
            : path === "CLAUDE.md" || path === "CLAUDE.local.md" || path === ".claude/CLAUDE.md";
    }
    if (kind === "Rule") {
        return path.endsWith(".md") && isUnderAny(path, sourceBases(kind, layout));
    }
    if (kind === "Workflow") {
        if (isUnderAny(path, [workflowGraphBase(layout)])) return true;
        return path.endsWith(".md") && isUnderAny(path, sourceBases(kind, layout));
    }
    if (kind === "Subagent") {
        return path.endsWith(".md") && isUnderAny(path, sourceBases(kind, layout));
    }
    if (kind === "Skill") return isUnderAny(path, sourceBases(kind, layout));
    return false;
}

function sourceBases(kind: AssetKind, layout: "config" | "project"): string[] {
    const prefix = layout === "config" ? "" : ".claude/";
    switch (kind) {
        case "Rule":
            return [`${prefix}rules`];
        case "Workflow":
            return layout === "config" ? ["commands", "workflows"] : [".claude/commands", ".claude/workflows"];
        case "Skill":
            return [`${prefix}skills`];
        case "Subagent":
            return [`${prefix}agents`];
        case "Guidance":
            return layout === "project" ? [".claude"] : [];
        case "Memory":
            return [];
    }
}

function workflowGraphBase(layout: "config" | "project"): string {
    return layout === "config" ? "workflows" : ".claude/workflows";
}

function dispositionId(handle: ReadEntryHandle): string {
    return `claudecode-disposition:${handle.readEntryHandleId}`;
}
