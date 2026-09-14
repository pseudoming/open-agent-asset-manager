import type { ProtocolEnvironmentSelectorV1, ProtocolOperationResult } from "@oaam/app-server-protocol";
import type { DesktopMessageId } from "../../presentation/localization";

export { WORKBENCH_ROUTE_SURFACES } from "./desktop-surface-inventory";

export type WorkbenchSubject =
    | { readonly subjectKind: "global" }
    | { readonly subjectKind: "project"; readonly projectId: string };

export const SETTINGS_CATEGORIES = ["general", "environments", "backup_recovery", "diagnostics", "maintenance"] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

type AssetKindCountsValue = Extract<ProtocolOperationResult<"asset_library.kind_counts">, { readonly value: unknown }>["value"];

export type WorkbenchAssetKind = AssetKindCountsValue["counts"][number]["kind"];
export type WorkbenchProjectCollection = "project" | "global";

export const SETTINGS_CATEGORY_PRESENTATION = Object.freeze({
    general: Object.freeze({ title: "settings.general.title", copy: "settings.general.copy" }),
    environments: Object.freeze({ title: "settings.runtime.title", copy: "settings.runtime.copy" }),
    backup_recovery: Object.freeze({ title: "state_resilience.title", copy: "state_resilience.copy" }),
    diagnostics: Object.freeze({ title: "diagnostics.title", copy: "diagnostics.copy" }),
    maintenance: Object.freeze({ title: "settings.maintenance.title", copy: "settings.maintenance.copy" }),
}) satisfies Readonly<Record<SettingsCategory, { readonly title: DesktopMessageId; readonly copy: DesktopMessageId }>>;

export type WorkbenchLibraryCollectionRoute =
    | {
          readonly surface: "library";
          readonly subject: "projects";
          readonly projectId: string;
          readonly collection: WorkbenchProjectCollection;
          readonly kind?: WorkbenchAssetKind;
          readonly assetId?: string;
          readonly versionId?: string;
      }
    | {
          readonly surface: "library";
          readonly subject: "global";
          readonly collection: "global";
          readonly kind?: WorkbenchAssetKind;
          readonly assetId?: string;
          readonly versionId?: string;
      };

export type WorkbenchLibraryRoute =
    | {
          readonly surface: "library";
          readonly subject: "projects";
          readonly projectId?: string;
          readonly collection?: never;
          readonly kind?: never;
          readonly assetId?: string;
          readonly versionId?: string;
      }
    | {
          readonly surface: "library";
          readonly subject: "global";
          readonly collection?: never;
          readonly kind?: never;
          readonly assetId?: string;
          readonly versionId?: string;
      }
    | WorkbenchLibraryCollectionRoute;

export type WorkbenchSourcesRoute =
    | { readonly surface: "sources"; readonly selection: "all" }
    | {
          readonly surface: "sources";
          readonly selection: "environment";
          readonly environment: ProtocolEnvironmentSelectorV1;
      }
    | {
          readonly surface: "sources";
          readonly selection: "source";
          readonly environment: ProtocolEnvironmentSelectorV1;
          readonly canonicalPath: string;
      };

export type WorkbenchRoute =
    | WorkbenchLibraryRoute
    | WorkbenchSourcesRoute
    | { readonly surface: "deployment"; readonly subject: WorkbenchSubject; readonly assetId?: string }
    | { readonly surface: "guided_import"; readonly targetProjectId?: string }
    | { readonly surface: "settings"; readonly category: SettingsCategory };

export interface WorkbenchNavigationState {
    readonly entries: readonly WorkbenchRoute[];
    readonly index: number;
}

export function createWorkbenchNavigation(initialRoute: WorkbenchRoute): WorkbenchNavigationState {
    return Object.freeze({ entries: Object.freeze([initialRoute]), index: 0 });
}

export function currentWorkbenchRoute(state: WorkbenchNavigationState): WorkbenchRoute {
    const route = state.entries[state.index];
    if (route === undefined) throw new Error("workbench navigation has no current route");
    return route;
}

function sameSubject(left: WorkbenchSubject, right: WorkbenchSubject): boolean {
    return (
        left.subjectKind === right.subjectKind &&
        (left.subjectKind === "global" || (right.subjectKind === "project" && left.projectId === right.projectId))
    );
}

function sameEnvironment(left: ProtocolEnvironmentSelectorV1, right: ProtocolEnvironmentSelectorV1): boolean {
    return left.platform === right.platform && left.platformInstanceId === right.platformInstanceId;
}

function sameRoute(left: WorkbenchRoute, right: WorkbenchRoute): boolean {
    if (left.surface !== right.surface) return false;
    if (left.surface === "guided_import" && right.surface === "guided_import") {
        return left.targetProjectId === right.targetProjectId;
    }
    if (left.surface === "settings" && right.surface === "settings") return left.category === right.category;
    if (left.surface === "deployment" && right.surface === "deployment") {
        return left.assetId === right.assetId && sameSubject(left.subject, right.subject);
    }
    if (left.surface === "sources" && right.surface === "sources") {
        if (left.selection !== right.selection) return false;
        if (left.selection === "all" && right.selection === "all") return true;
        if (left.selection === "environment" && right.selection === "environment") {
            return sameEnvironment(left.environment, right.environment);
        }
        return (
            left.selection === "source" &&
            right.selection === "source" &&
            sameEnvironment(left.environment, right.environment) &&
            left.canonicalPath === right.canonicalPath
        );
    }
    if (left.surface !== "library" || right.surface !== "library" || left.subject !== right.subject) return false;
    return (
        left.assetId === right.assetId &&
        left.versionId === right.versionId &&
        left.kind === right.kind &&
        left.collection === right.collection &&
        (left.subject === "global" || (right.subject === "projects" && left.projectId === right.projectId))
    );
}

export function pushWorkbenchRoute(state: WorkbenchNavigationState, route: WorkbenchRoute): WorkbenchNavigationState {
    if (sameRoute(currentWorkbenchRoute(state), route)) return state;
    const entries = Object.freeze([...state.entries.slice(0, state.index + 1), route]);
    return Object.freeze({ entries, index: entries.length - 1 });
}

export function replaceWorkbenchRoute(state: WorkbenchNavigationState, route: WorkbenchRoute): WorkbenchNavigationState {
    if (sameRoute(currentWorkbenchRoute(state), route)) return state;
    const entries = Object.freeze(state.entries.map((entry, index) => (index === state.index ? route : entry)));
    return Object.freeze({ entries, index: state.index });
}

export function moveWorkbenchHistory(state: WorkbenchNavigationState, direction: "back" | "forward"): WorkbenchNavigationState {
    const index = direction === "back" ? Math.max(0, state.index - 1) : Math.min(state.entries.length - 1, state.index + 1);
    return index === state.index ? state : Object.freeze({ entries: state.entries, index });
}

export function canMoveWorkbenchHistory(state: WorkbenchNavigationState, direction: "back" | "forward"): boolean {
    return direction === "back" ? state.index > 0 : state.index < state.entries.length - 1;
}

export function leaveWorkbenchSettings(state: WorkbenchNavigationState, fallbackRoute: WorkbenchRoute): WorkbenchNavigationState {
    if (currentWorkbenchRoute(state).surface !== "settings") return state;
    let index = state.index - 1;
    while (index >= 0 && state.entries[index]?.surface === "settings") index -= 1;
    if (index >= 0) return Object.freeze({ entries: state.entries, index });
    return replaceWorkbenchRoute(state, fallbackRoute);
}
