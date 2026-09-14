const ACTUAL_RENDER_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const ACTUAL_RENDER_PROJECT_ROOT =
    "/a/very/long/project/root/used/to/prove/the/sidebar/never/creates/a/horizontal/scrollbar";

export async function authorizeActualRenderRegisteredProjectRoot(projectId: string) {
    document.documentElement.dataset.oaamRegisteredProjectAuthorization = projectId;
    return Object.freeze({
        status: "authorized" as const,
        displayPath: ACTUAL_RENDER_PROJECT_ROOT,
        localPathSelectionToken: "actual-render-registered-project-root",
    });
}

export async function revealActualRenderRegisteredProjectRoot(projectId: string) {
    document.documentElement.dataset.oaamRegisteredProjectReveal = projectId;
    return Object.freeze({ status: "complete" as const });
}

export async function getActualRenderRegisteredProject(input: { readonly projectId: string }) {
    if (input.projectId !== ACTUAL_RENDER_PROJECT_ID) {
        return Object.freeze({ status: "complete" as const, value: { found: false as const }, diagnostics: [] });
    }
    return Object.freeze({
        status: "complete" as const,
        value: {
            found: true as const,
            value: {
                projectId: ACTUAL_RENDER_PROJECT_ID,
                displayName: "Open Agent Asset Manager",
                rootPath: ACTUAL_RENDER_PROJECT_ROOT,
                deleted: false,
                createdAt: 1,
                updatedAt: 2,
            },
        },
        diagnostics: [],
    });
}
