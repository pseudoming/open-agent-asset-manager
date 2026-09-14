import { desktopEnvironmentKey } from "../../../desktop-environment-key";
import type { EnvironmentListView, ProjectListView, WatchedScanIntentView } from "./discovery-model";

type ProjectRootEnvironment =
    | { readonly kind: "win32" }
    | { readonly kind: "wsl"; readonly platformInstanceId: string }
    | { readonly kind: "posix" }
    | { readonly kind: "unknown" };

export type ProjectEnvironmentConstraint =
    | { readonly kind: "unconstrained" }
    | { readonly kind: "unavailable"; readonly selectableKeys: readonly string[] }
    | { readonly kind: "exact"; readonly selectableKeys: readonly string[] }
    | { readonly kind: "choose"; readonly selectableKeys: readonly string[] };

function projectRootEnvironment(rootPath: string): ProjectRootEnvironment {
    const wsl = /^\\\\wsl\.localhost\\([^\\]+)(?:\\|$)/iu.exec(rootPath);
    if (wsl?.[1] !== undefined) return Object.freeze({ kind: "wsl", platformInstanceId: wsl[1] });
    if (/^[a-z]:[\\/]/iu.test(rootPath) || /^\\\\/u.test(rootPath)) return Object.freeze({ kind: "win32" });
    if (rootPath.startsWith("/")) return Object.freeze({ kind: "posix" });
    return Object.freeze({ kind: "unknown" });
}

export function targetProject(
    targetProjectId: string | undefined,
    projects: ProjectListView["projects"],
): ProjectListView["projects"][number] | null | undefined {
    if (targetProjectId === undefined) return undefined;
    return projects.find((project) => !project.deleted && project.projectId === targetProjectId) ?? null;
}

export function environmentMatchesProjectRoot(
    environment: EnvironmentListView["environments"][number]["environment"],
    rootPath: string,
): boolean {
    const rootEnvironment = projectRootEnvironment(rootPath);
    if (rootEnvironment.kind === "win32") return environment.platform === "win32";
    if (rootEnvironment.kind === "wsl") {
        return (
            environment.platform === "wsl" &&
            environment.platformInstanceId.localeCompare(rootEnvironment.platformInstanceId, "en", {
                sensitivity: "accent",
            }) === 0
        );
    }
    if (rootEnvironment.kind === "posix") {
        return environment.platform === "wsl" || environment.platform === "linux" || environment.platform === "darwin";
    }
    return false;
}

function watchedProjectEnvironmentKeys(targetProjectId: string, watched: WatchedScanIntentView): ReadonlySet<string> {
    return new Set(
        watched.environments.flatMap((environment) =>
            environment.sourceSelectors.some(
                (selector) =>
                    selector.disposition === "included" &&
                    selector.binding.assetScope === "project" &&
                    selector.binding.projectId === targetProjectId,
            )
                ? [desktopEnvironmentKey(environment.environment)]
                : [],
        ),
    );
}

export function projectEnvironmentConstraint(
    targetProjectId: string | undefined,
    projects: ProjectListView["projects"],
    watched: WatchedScanIntentView,
    environments: EnvironmentListView["environments"],
): ProjectEnvironmentConstraint {
    const project = targetProject(targetProjectId, projects);
    if (project === undefined) return Object.freeze({ kind: "unconstrained" });
    if (project === null) return Object.freeze({ kind: "unavailable", selectableKeys: Object.freeze([]) });
    const compatibleKeys = environments
        .filter((environment) => environmentMatchesProjectRoot(environment.environment, project.rootPath))
        .map((environment) => desktopEnvironmentKey(environment.environment));
    const watchedKeys = watchedProjectEnvironmentKeys(project.projectId, watched);
    const boundCompatibleKeys = compatibleKeys.filter((key) => watchedKeys.has(key));
    const selectableKeys = Object.freeze(boundCompatibleKeys.length > 0 ? boundCompatibleKeys : compatibleKeys);
    if (selectableKeys.length === 0) return Object.freeze({ kind: "unavailable", selectableKeys });
    if (selectableKeys.length === 1) return Object.freeze({ kind: "exact", selectableKeys });
    return Object.freeze({ kind: "choose", selectableKeys });
}
