interface ProjectLabelSource {
    readonly displayName: string;
    readonly rootPath?: string;
    readonly projectId?: string;
}

/** Present unnamed Projects without changing their stored name or rename input. */
export function projectDisplayName(project: ProjectLabelSource): string;
export function projectDisplayName(project: ProjectLabelSource | undefined): string | undefined;
export function projectDisplayName(project: ProjectLabelSource | undefined): string | undefined {
    if (project === undefined) return undefined;
    if (project.displayName.trim() !== "") return project.displayName;
    const rootPath = project.rootPath ?? "";
    return rootPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? (rootPath || project.projectId || "");
}
