import type { DesktopMessageId, DesktopMessageValues } from "../../presentation";
import type {
    AssetSummaryView,
    DeploymentView,
    RenderAnalysisView,
    RenderOptionView,
    RenderPreviewView,
    RenderSemanticView,
} from "./catalog-deployment-model";

export function deploymentAssetVersionLabels(
    deployment: DeploymentView,
    assets: readonly AssetSummaryView[],
    text: (id: DesktopMessageId, values?: DesktopMessageValues) => string,
): readonly string[] {
    return deployment.assets.map((selection) => {
        const asset = assets.find((entry) => entry.assetId === selection.assetId);
        return asset !== undefined && asset.currentVersionId === selection.versionId
            ? text("catalog.ui.create.asset_revision", { asset: asset.displayName, revision: asset.currentRevision })
            : text("catalog.ui.create.selected_asset_version", {
                  asset: asset?.displayName ?? text("import.ui.result.unknown_asset"),
              });
    });
}

type RenderSemanticKind = RenderAnalysisView["semantics"][number]["semanticKind"];
type RenderStrategy = RenderOptionView["renderStrategy"];
type ReversePolicy = RenderOptionView["actualReverseExtractPolicy"];
type DegradationKind = Extract<RenderOptionView, { readonly outcome: "degraded" }>["degradationKinds"][number];
type ApprovalConcern = Extract<RenderOptionView, { readonly approvalState: "required" }>["approvalConcerns"][number];

export const PREVIEW_CHANGE_MESSAGES = Object.freeze({
    create: "catalog.ui.preview.change.create",
    unchanged: "catalog.ui.preview.change.unchanged",
    update_managed: "catalog.ui.preview.change.update_managed",
    remove_managed: "catalog.ui.preview.change.remove_managed",
    establish_baseline: "catalog.ui.preview.change.establish_baseline",
    replace_unmanaged: "catalog.ui.preview.change.replace_unmanaged",
    managed_conflict: "catalog.ui.preview.change.managed_conflict",
} as const satisfies Record<string, DesktopMessageId>);

export function previewFileChangeMessage(file: RenderPreviewView["files"][number]): DesktopMessageId {
    return file.changeKind === "replace_unmanaged" && file.desired.state === "missing"
        ? "catalog.ui.preview.change.remove_unmanaged"
        : PREVIEW_CHANGE_MESSAGES[file.changeKind];
}

export function previewEntryIsUnchanged(
    entry: Pick<RenderPreviewView["files"][number] | RenderPreviewView["directories"][number], "changeKind">,
): boolean {
    return entry.changeKind === "unchanged" || entry.changeKind === "establish_baseline";
}

/** Display only: the reviewed graph, not this shared prefix, owns write authority. */
export function previewGraphPathLabels(preview: Pick<RenderPreviewView, "files" | "directories">): {
    readonly root: string | undefined;
    readonly label: (relativePath: string) => string;
} {
    const paths = [...preview.directories, ...preview.files].map((entry) => entry.relativePath);
    const root = preview.directories
        .map((entry) => entry.relativePath)
        .find((candidate) => candidate !== "" && paths.every((path) => path === candidate || path.startsWith(`${candidate}/`)));
    return {
        root,
        label: (relativePath) =>
            root === undefined ? relativePath : relativePath === root ? "." : relativePath.slice(root.length + 1),
    };
}

export const PREVIEW_DIRECTORY_CHANGE_MESSAGES = Object.freeze({
    create: "catalog.ui.preview.directory.change.create",
    unchanged: "catalog.ui.preview.directory.change.unchanged",
    remove_managed: "catalog.ui.preview.directory.change.remove_managed",
    remove_unmanaged: "catalog.ui.preview.directory.change.remove_unmanaged",
} as const satisfies Record<string, DesktopMessageId>);

export const PREVIEW_ACTION_MESSAGES = Object.freeze({
    ready_apply: "catalog.ui.preview.action.ready_apply",
    requires_unmanaged_replacement: "catalog.ui.preview.action.requires_unmanaged_replacement",
    blocked_managed_conflict: "catalog.ui.preview.action.blocked_managed_conflict",
} as const satisfies Record<string, DesktopMessageId>);

export const RENDER_SEMANTIC_MESSAGES = Object.freeze({
    "asset.file_inventory": "catalog.ui.render.semantic.asset_file_inventory",
    "guidance.base_context": "catalog.ui.render.semantic.guidance_base_context",
    "guidance.content": "catalog.ui.render.semantic.guidance_content",
    "rule.activation": "catalog.ui.render.semantic.rule_activation",
    "rule.content": "catalog.ui.render.semantic.rule_content",
    "workflow.activation": "catalog.ui.render.semantic.workflow_activation",
    "workflow.content": "catalog.ui.render.semantic.workflow_content",
    "workflow.reference": "catalog.ui.render.semantic.workflow_reference",
    "skill.discovery_metadata": "catalog.ui.render.semantic.skill_discovery_metadata",
    "skill.body": "catalog.ui.render.semantic.skill_body",
    "skill.resource": "catalog.ui.render.semantic.skill_resource",
    "subagent.delegation_metadata": "catalog.ui.render.semantic.subagent_delegation_metadata",
    "subagent.invoked_context": "catalog.ui.render.semantic.subagent_invoked_context",
    "subagent.resource": "catalog.ui.render.semantic.subagent_resource",
    "subagent.tool_boundary": "catalog.ui.render.semantic.subagent_tool_boundary",
    "subagent.model_hint": "catalog.ui.render.semantic.subagent_model_hint",
    "memory.support": "catalog.ui.render.semantic.memory_support",
    "memory.content": "catalog.ui.render.semantic.memory_content",
} as const satisfies Readonly<Record<RenderSemanticKind, DesktopMessageId>>);

export const RENDER_STRATEGY_MESSAGES = Object.freeze({
    native_file: "catalog.ui.render.strategy.native_file",
    native_directory: "catalog.ui.render.strategy.native_directory",
    native_graph: "catalog.ui.render.strategy.native_graph",
    native_import: "catalog.ui.render.strategy.native_import",
    inline: "catalog.ui.render.strategy.inline",
    reference_with_intro: "catalog.ui.render.strategy.reference_with_intro",
} as const satisfies Readonly<Record<RenderStrategy, DesktopMessageId>>);

export const RENDER_REVERSE_MESSAGES = Object.freeze({
    can_reconcile: "catalog.ui.render.reverse.can_reconcile",
    ignore_generated_wrapper: "catalog.ui.render.reverse.ignore_generated_wrapper",
    unsupported: "catalog.ui.render.reverse.unsupported",
} as const satisfies Readonly<Record<ReversePolicy, DesktopMessageId>>);

export const RENDER_DEGRADATION_MESSAGES = Object.freeze({
    target_runtime_missing_asset_kind: "catalog.ui.render.degradation.target_runtime_missing_asset_kind",
    trigger_or_loading_level_lost: "catalog.ui.render.degradation.trigger_or_loading_level_lost",
    workflow_trigger_lost: "catalog.ui.render.degradation.workflow_trigger_lost",
    workflow_permission_lost: "catalog.ui.render.degradation.workflow_permission_lost",
    workflow_runtime_lost: "catalog.ui.render.degradation.workflow_runtime_lost",
    workflow_variable_lost: "catalog.ui.render.degradation.workflow_variable_lost",
    permission_or_tool_boundary_lost: "catalog.ui.render.degradation.permission_or_tool_boundary_lost",
    folder_asset_flattened: "catalog.ui.render.degradation.folder_asset_flattened",
    memory_semantics_lost: "catalog.ui.render.degradation.memory_semantics_lost",
    runtime_specific_metadata_lost: "catalog.ui.render.degradation.runtime_specific_metadata_lost",
    reverse_extract_pollution_risk: "catalog.ui.render.degradation.reverse_extract_pollution_risk",
} as const satisfies Readonly<Record<DegradationKind, DesktopMessageId>>);

export const RENDER_APPROVAL_MESSAGES = Object.freeze({
    semantic_degradation: "catalog.ui.render.approval.semantic_degradation",
    reverse_extract_unsupported: "catalog.ui.render.approval.reverse_extract_unsupported",
} as const satisfies Readonly<Record<ApprovalConcern, DesktopMessageId>>);

interface ClaudeExactFileDispositionMessages {
    readonly preserved: DesktopMessageId;
    readonly blocked: DesktopMessageId;
    readonly blockedReasonCode: string;
}

export interface ClaudeExactFileDispositionPresentation {
    readonly state: "preserved" | "blocked";
    readonly title: DesktopMessageId;
    readonly detail: DesktopMessageId;
    readonly boundary?: DesktopMessageId;
}

const CLAUDE_EXACT_FILE_DISPOSITIONS = Object.freeze({
    "workflow.content": {
        preserved: "catalog.ui.render.claude.preserved.workflow",
        blocked: "catalog.ui.render.claude.blocked.workflow",
        blockedReasonCode: "claudecode_project_workflow_exact_file_blocked",
    },
    "skill.body": {
        preserved: "catalog.ui.render.claude.preserved.skill",
        blocked: "catalog.ui.render.claude.blocked.skill",
        blockedReasonCode: "claudecode_project_skill_exact_file_blocked",
    },
    "subagent.invoked_context": {
        preserved: "catalog.ui.render.claude.preserved.subagent",
        blocked: "catalog.ui.render.claude.blocked.subagent",
        blockedReasonCode: "claudecode_project_subagent_exact_file_blocked",
    },
} as const satisfies Partial<Record<RenderSemanticKind, ClaudeExactFileDispositionMessages>>);

export function presentClaudeExactFileDisposition(
    semantic: RenderSemanticView,
    evidence:
        | { readonly state: "option"; readonly option: RenderOptionView }
        | { readonly state: "blocked"; readonly reasonCode: string },
): ClaudeExactFileDispositionPresentation | undefined {
    if (semantic.consumerAgentRuntimeId !== "CLAUDE_CODE_CLI") return undefined;
    const messages = CLAUDE_EXACT_FILE_DISPOSITIONS[semantic.semanticKind as keyof typeof CLAUDE_EXACT_FILE_DISPOSITIONS];
    if (messages === undefined) return undefined;
    if (evidence.state === "option") {
        if (evidence.option.outcome !== "preserved" || evidence.option.reasonCode !== "native_project_exact_file_preserved") {
            return undefined;
        }
        return {
            state: "preserved",
            title: "catalog.ui.render.claude.title.preserved",
            detail: messages.preserved,
            boundary: "catalog.ui.render.claude.no_silent_degradation",
        };
    }
    return evidence.reasonCode === messages.blockedReasonCode
        ? {
              state: "blocked",
              title: "catalog.ui.render.claude.title.blocked",
              detail: messages.blocked,
          }
        : undefined;
}
