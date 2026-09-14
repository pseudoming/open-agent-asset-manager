/** OpenCode Core-port traversal, source layout resolution, and read accounting. */

import type {
    AdapterAssetSourceCapability,
    AdapterProviderReadInput,
    AssetKind,
    SourceReadObligation,
    SourceRoot,
} from "@oaam/core";
import { traverseSourceRead } from "@oaam/adapter-framework";
import { parseOpencodeFrontmatter } from "./opencode-frontmatter";
import { dispositionId, isUnderAny, isWithin, readDiagnostic } from "./opencode-source-read-foundation";
import { isManifestPath } from "./opencode-source-read-jsonc";
import type { ScanResult, SourceContext, WorkflowReferenceClassification } from "./opencode-source-read-model";
import { classifyOpenCodeAtReferences } from "./opencode-source-read-references";

export async function scanOpencodeReadObligation(
    input: AdapterProviderReadInput,
    obligation: SourceReadObligation,
    capability: AdapterAssetSourceCapability,
    context: SourceContext,
): Promise<ScanResult> {
    const unreadableRelativePaths: string[] = [];
    const workflowReferencesByPath = new Map<string, WorkflowReferenceClassification>();
    const scan = await traverseSourceRead(
        input,
        obligation,
        capability,
        context,
        {
            shouldEnterDirectory,
            shouldReadFile,
            isIndependentSourceEntry: (kind, sourceContext, entry, ancestorFiles) => {
                if (kind === "Guidance") return true;
                const bases = sourceBases("Skill", sourceContext);
                if (kind !== "Skill" || !isUnderAny(entry.relativePath, bases)) return false;
                if (entry.entryKind === "file" && entry.relativePath !== "SKILL.md" && !entry.relativePath.endsWith("/SKILL.md"))
                    return false;
                // A parent Skill may own this directory as a resource. Without reading the guarded
                // subtree, its nested entry cannot be proven, so retain the Core read failure.
                return !ancestorFiles.some(
                    (file) =>
                        file.relativePath !== entry.relativePath &&
                        (file.relativePath === "SKILL.md" || file.relativePath.endsWith("/SKILL.md")) &&
                        isUnderAny(file.relativePath, bases) &&
                        entry.relativePath.startsWith(file.relativePath.slice(0, -"SKILL.md".length)),
                );
            },
            dispositionId,
            rootEntryKindDiagnostic: (sourceContext, expectedKind) =>
                expectedKind === "directory"
                    ? readDiagnostic(
                          "opencode.source_root_not_directory",
                          "OpenCode source roots must be directories",
                          "invalid_schema",
                          "error",
                          sourceContext.root.path,
                      )
                    : readDiagnostic(
                          "opencode.source_root_not_file",
                          "OpenCode source capability requires a file root",
                          "invalid_schema",
                          "error",
                          sourceContext.root.path,
                      ),
            mechanismNotCallableDiagnostic: (sourceContext) =>
                readDiagnostic(
                    "opencode.source_path_mechanism_not_callable",
                    "OpenCode source path mechanism is not callable for the selected root",
                    "invalid_schema",
                    "error",
                    sourceContext.root.path,
                ),
            onFileReadFailure: (relativePath) => unreadableRelativePaths.push(relativePath),
        },
        { unreadableRelativePaths, workflowReferencesByPath },
    );
    if (capability.assetKind === "Workflow") {
        await classifyWorkflowReferences();
    }
    return scan;

    async function classifyWorkflowReferences(): Promise<void> {
        for (const file of scan.files.filter(
            (item) => !isManifestPath(item.relativePath, context.layout) && item.text !== null,
        )) {
            const parsed = parseOpencodeFrontmatter(file.text as string);
            const body = parsed.hasFrontmatter && parsed.closed ? parsed.body : (file.text as string);
            const classification = await classifyOpenCodeAtReferences(input, obligation, context, file.relativePath, body);
            for (const handle of classification.classificationHandles) {
                scan.ignoreHandle(handle, "workflow_reference_classification_only");
            }
            workflowReferencesByPath.set(file.relativePath, classification);
        }
    }
}

export function resolveSourceContext(input: AdapterProviderReadInput, root: SourceRoot): SourceContext | null {
    const selector = input.target.sourceSelector;
    if (selector.selectorKind === "user_selected_root") {
        return {
            root,
            scope: selector.binding.assetScope,
            projectRootPath: selector.binding.projectRootPath,
            layout: "external",
            platform: selector.platformContext.platform,
            guidanceEnabled: true,
            projectConfigEnabled: true,
            externalSkillsEnabled: true,
            claudePromptEnabled: true,
            claudeSkillsEnabled: true,
        };
    }
    if (root.rootRole === "project_actual" && root.sourceDomain === "project_root") {
        const locatorKey = root.locatorEvidence.map((item) => item.locatorKey).join("\0");
        return {
            root,
            scope: "project",
            projectRootPath: root.path,
            layout: "project",
            platform: selector.observation.platformContext.platform,
            guidanceEnabled: true,
            projectConfigEnabled: !locatorKey.includes("project_config_off"),
            externalSkillsEnabled: !locatorKey.includes("external_skills_off"),
            claudePromptEnabled: !locatorKey.includes("claude_prompt_off"),
            claudeSkillsEnabled: !locatorKey.includes("claude_skills_off"),
        };
    }
    if (root.rootRole === "config" && root.sourceDomain === "agent_runtime_private") {
        const guidanceEnabled = root.locatorEvidence.some((item) => item.locatorKey.startsWith("opencode_global_config:"));
        return {
            root,
            scope: "global",
            projectRootPath: "",
            layout: "config",
            platform: selector.observation.platformContext.platform,
            guidanceEnabled,
            projectConfigEnabled: true,
            externalSkillsEnabled: true,
            claudePromptEnabled: true,
            claudeSkillsEnabled: true,
        };
    }
    if (
        root.rootRole === "config" &&
        root.sourceDomain === "family_shared" &&
        root.locatorEvidence.some((item) => item.locatorKey === "opencode_claude_compat_guidance")
    ) {
        return {
            root,
            scope: "global",
            projectRootPath: "",
            layout: "claude_guidance",
            platform: selector.observation.platformContext.platform,
            guidanceEnabled: true,
            projectConfigEnabled: true,
            externalSkillsEnabled: true,
            claudePromptEnabled: true,
            claudeSkillsEnabled: true,
        };
    }
    if (root.rootRole === "source" && root.sourceDomain === "family_shared") {
        return {
            root,
            scope: "global",
            projectRootPath: "",
            layout: "skill_root",
            platform: selector.observation.platformContext.platform,
            guidanceEnabled: false,
            projectConfigEnabled: true,
            externalSkillsEnabled: true,
            claudePromptEnabled: true,
            claudeSkillsEnabled: true,
        };
    }
    return null;
}

function shouldEnterDirectory(kind: AssetKind, context: SourceContext, path: string): boolean {
    if (kind === "Guidance" || kind === "Rule" || kind === "Memory") return false;
    const bases = sourceBases(kind, context);
    return bases.some((base) => base === "" || isWithin(path, base) || isWithin(base, path));
}

function shouldReadFile(kind: AssetKind, context: SourceContext, path: string): boolean {
    if (
        isManifestPath(path, context.layout) &&
        context.projectConfigEnabled &&
        (kind === "Workflow" || kind === "Skill" || kind === "Subagent")
    ) {
        return true;
    }
    if (kind === "Guidance") {
        if (!context.guidanceEnabled) return false;
        if (context.layout === "claude_guidance") return path === "CLAUDE.md";
        if (context.layout !== "project") return path === "AGENTS.md";
        if (!context.projectConfigEnabled) return false;
        return path === "AGENTS.md" || path === "CONTEXT.md" || (context.claudePromptEnabled && path === "CLAUDE.md");
    }
    if (kind === "Workflow" || kind === "Subagent") {
        return path.endsWith(".md") && isUnderAny(path, sourceBases(kind, context));
    }
    if (kind === "Skill") return isUnderAny(path, sourceBases(kind, context));
    return false;
}

function sourceBases(kind: AssetKind, context: SourceContext): string[] {
    if (context.layout === "external") {
        if (kind === "Workflow") return ["command", "commands", ".opencode/command", ".opencode/commands"];
        if (kind === "Subagent") return ["agent", "agents", ".opencode/agent", ".opencode/agents"];
        if (kind === "Skill") return [""];
        return [];
    }
    if (kind === "Workflow") {
        return context.layout === "project" && context.projectConfigEnabled
            ? [".opencode/command", ".opencode/commands"]
            : context.layout === "project"
              ? []
              : ["command", "commands"];
    }
    if (kind === "Subagent") {
        return context.layout === "project" && context.projectConfigEnabled
            ? [".opencode/agent", ".opencode/agents"]
            : context.layout === "project"
              ? []
              : ["agent", "agents"];
    }
    if (kind === "Skill") {
        if (context.layout === "skill_root") return [""];
        return context.layout === "project"
            ? [
                  ...(context.projectConfigEnabled ? [".opencode/skill", ".opencode/skills"] : []),
                  ...(context.externalSkillsEnabled ? [".agents/skills"] : []),
                  ...(context.claudeSkillsEnabled ? [".claude/skills"] : []),
              ]
            : ["skill", "skills"];
    }
    return [];
}
