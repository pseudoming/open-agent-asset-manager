import { projectDisplayName } from "../../presentation/project-label";
import type { ProtocolOperationResult } from "@oaam/app-server-protocol";
import type { WorkbenchLibraryRoute } from "../../app/workbench-navigation";
import type { DesktopApplicationClientApi } from "../../client";
import type { DesktopMessageId } from "../../presentation";

type OutcomeValue<
    TName extends
        | "project.list"
        | "adapter_provider.list"
        | "asset.get"
        | "asset_library.kind_counts"
        | "asset_library.page"
        | "asset_version.list"
        | "asset_version.file_children",
> = Extract<ProtocolOperationResult<TName>, { readonly value: unknown }>["value"];

export type ProjectView = OutcomeValue<"project.list">["projects"][number];
export type AssetSummaryView = OutcomeValue<"asset_library.page">["assets"][number];
export type AssetView = Extract<OutcomeValue<"asset.get">, { readonly found: true }>["value"];
export type AssetVersionSummaryView = Extract<
    OutcomeValue<"asset_version.list">,
    { readonly found: true }
>["value"]["versions"][number];
export type AssetVersionFileTreeEntryView = Extract<
    OutcomeValue<"asset_version.file_children">,
    { readonly found: true }
>["value"]["entries"][number];
export type AssetKindView = AssetSummaryView["kind"];
export type ProjectLibrarySubject = "projects" | "global";
type AdapterProviderView = OutcomeValue<"adapter_provider.list">["providers"][number];

/** Locate a returned Asset by its own scope and kind, independent of the source view. */
export function assetLibraryRoute(asset: Pick<AssetView, "assetId" | "scope" | "projectId" | "kind">): WorkbenchLibraryRoute {
    if (asset.scope === "global") {
        return { surface: "library", subject: "global", collection: "global", kind: asset.kind, assetId: asset.assetId };
    }
    if (asset.projectId === undefined) throw new Error("A Project Asset must have a Project identity");
    return {
        surface: "library",
        subject: "projects",
        projectId: asset.projectId,
        collection: "project",
        kind: asset.kind,
        assetId: asset.assetId,
    };
}

export interface AssetTargetSupportView {
    readonly key: string;
    readonly displayName: string;
    readonly agentRuntimeIds: readonly string[];
}

export const ASSET_KIND_ORDER = Object.freeze([
    "Guidance",
    "Rule",
    "Workflow",
    "Skill",
    "Subagent",
    "Memory",
] as const satisfies readonly AssetKindView[]);

export const ASSET_KIND_MESSAGE_IDS = Object.freeze({
    Guidance: "library.kind.guidance",
    Rule: "library.kind.rule",
    Workflow: "library.kind.workflow",
    Skill: "library.kind.skill",
    Subagent: "library.kind.subagent",
    Memory: "library.kind.memory",
} satisfies Readonly<Record<AssetKindView, DesktopMessageId>>);

export const ASSET_KIND_HELP_MESSAGE_IDS = Object.freeze({
    Guidance: "library.kind.guidance_help",
    Rule: "library.kind.rule_help",
    Workflow: "library.kind.workflow_help",
    Skill: "library.kind.skill_help",
    Subagent: "library.kind.subagent_help",
    Memory: "library.kind.memory_help",
} satisfies Readonly<Record<AssetKindView, DesktopMessageId>>);

export function supportsProjectRegistration(client: DesktopApplicationClientApi): boolean {
    return client.supportsOperation("project.register");
}

function compareDisplayText(left: string, right: string): number {
    const foldedLeft = left.toLocaleLowerCase("en-US");
    const foldedRight = right.toLocaleLowerCase("en-US");
    if (foldedLeft < foldedRight) return -1;
    if (foldedLeft > foldedRight) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
}

export function activeProjects(projects: readonly ProjectView[]): readonly ProjectView[] {
    return Object.freeze(
        [...projects]
            .filter((project) => !project.deleted)
            .sort(
                (left, right) =>
                    compareDisplayText(projectDisplayName(left), projectDisplayName(right)) ||
                    compareDisplayText(left.projectId, right.projectId),
            ),
    );
}

export function retainedProjects(projects: readonly ProjectView[]): readonly ProjectView[] {
    return Object.freeze(
        [...projects]
            .filter((project) => project.deleted)
            .sort(
                (left, right) =>
                    compareDisplayText(projectDisplayName(left), projectDisplayName(right)) ||
                    compareDisplayText(left.projectId, right.projectId),
            ),
    );
}

export function chooseInitialProjectId(
    projects: readonly ProjectView[],
    preferredProjectId: string | undefined,
): string | undefined {
    const active = activeProjects(projects);
    return active.some((project) => project.projectId === preferredProjectId) ? preferredProjectId : active[0]?.projectId;
}

export function buildAssetTargetSupport(
    providers: readonly AdapterProviderView[],
): ReadonlyMap<AssetKindView, readonly AssetTargetSupportView[]> {
    const targets = new Map<AssetKindView, Map<string, AssetTargetSupportView>>(
        ASSET_KIND_ORDER.map((kind) => [kind, new Map()]),
    );
    for (const provider of providers) {
        const runtimes = provider.agentRuntimes
            .map((runtime) => ({
                agentRuntimeId: runtime.agentRuntimeId,
                displayName: runtime.displayName.trim(),
            }))
            .filter((runtime) => runtime.displayName !== "");
        for (const kind of ASSET_KIND_ORDER) {
            const supportedRuntimeIds = new Set(
                provider.targetCapabilities
                    .filter((capability) => capability.assetKind === kind && capability.entrySupportStatus === "supported")
                    .map((capability) => capability.agentRuntimeId),
            );
            const supportedRuntimes = runtimes.filter((runtime) => supportedRuntimeIds.has(runtime.agentRuntimeId));
            if (supportedRuntimes.length === 0) continue;
            if (supportedRuntimes.length === runtimes.length && provider.displayName.trim() !== "") {
                const key = `provider:${provider.adapterId}`;
                targets.get(kind)?.set(key, {
                    key,
                    displayName: provider.displayName.trim(),
                    agentRuntimeIds: Object.freeze(supportedRuntimes.map((runtime) => runtime.agentRuntimeId).sort()),
                });
                continue;
            }
            for (const runtime of supportedRuntimes) {
                const key = `runtime:${runtime.agentRuntimeId}`;
                targets.get(kind)?.set(key, {
                    key,
                    displayName: runtime.displayName,
                    agentRuntimeIds: Object.freeze([runtime.agentRuntimeId]),
                });
            }
        }
    }
    return new Map(
        ASSET_KIND_ORDER.map((kind) => [
            kind,
            Object.freeze(
                [...(targets.get(kind)?.values() ?? [])].sort(
                    (left, right) =>
                        compareDisplayText(left.displayName, right.displayName) || compareDisplayText(left.key, right.key),
                ),
            ),
        ]),
    );
}
