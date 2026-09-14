import { projectDisplayName } from "../../presentation/project-label";
import type { ProtocolDiagnosticV1, ProtocolInvalidationV1 } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../client";
import {
    localizedText,
    nonInformationalProtocolDiagnostics,
    protocolFeedback,
    type DesktopDisplayText,
    type ProtocolFeedback,
} from "../../presentation";
import { activeProjects, chooseInitialProjectId, type ProjectView, retainedProjects } from "./project-library-model";

export type ProjectLibraryState =
    | { readonly status: "loading"; readonly message: DesktopDisplayText }
    | {
          readonly status: "failed";
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      }
    | {
          readonly status: "ready";
          readonly projects: readonly ProjectView[];
          readonly retainedProjects: readonly ProjectView[];
          readonly selectedProjectId: string | undefined;
          readonly registeringProject: boolean;
          readonly stale: boolean;
          readonly message: DesktopDisplayText | undefined;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      };

function outcomeFeedback(diagnostics: readonly ProtocolDiagnosticV1[], fallback: DesktopDisplayText): ProtocolFeedback {
    return protocolFeedback(fallback, diagnostics);
}

export class ProjectLibraryController {
    readonly #client: DesktopApplicationClientApi;
    readonly #preferredProjectId: string | undefined;
    readonly #listeners = new Set<(state: ProjectLibraryState) => void>();
    #state: ProjectLibraryState = Object.freeze({ status: "loading", message: localizedText("library.loading") });
    #loadGeneration = 0;
    #registrationGeneration = 0;
    #unsubscribeInvalidation: (() => void) | undefined;

    public constructor(client: DesktopApplicationClientApi, preferredProjectId?: string) {
        this.#client = client;
        this.#preferredProjectId = preferredProjectId;
    }

    public get state(): ProjectLibraryState {
        return this.#state;
    }

    public subscribe(listener: (state: ProjectLibraryState) => void): () => void {
        this.#listeners.add(listener);
        listener(this.#state);
        return () => this.#listeners.delete(listener);
    }

    public dispose(): void {
        this.#loadGeneration += 1;
        this.#registrationGeneration += 1;
        this.#unsubscribeInvalidation?.();
        this.#unsubscribeInvalidation = undefined;
        this.#listeners.clear();
    }

    public async load(): Promise<void> {
        const generation = ++this.#loadGeneration;
        this.#registrationGeneration += 1;
        this.#ensureInvalidationSubscription();
        if (!this.#client.supportsOperation("project.list")) {
            this.#transition(
                Object.freeze({
                    status: "failed",
                    message: localizedText("library.operation_unavailable"),
                    diagnostics: Object.freeze([]),
                }),
            );
            return;
        }
        const previousProjectId = this.#state.status === "ready" ? this.#state.selectedProjectId : undefined;
        this.#transition(Object.freeze({ status: "loading", message: localizedText("library.loading") }));
        try {
            const projects = await this.#client.listProjects({ includeDeleted: true });
            if (generation !== this.#loadGeneration) return;
            if (projects.status === "failed") {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        ...outcomeFeedback(projects.diagnostics, localizedText("library.load_failed")),
                    }),
                );
                return;
            }
            const sortedProjects = activeProjects(projects.value.projects);
            const selectedProjectId = chooseInitialProjectId(sortedProjects, previousProjectId ?? this.#preferredProjectId);
            this.#transition(
                Object.freeze({
                    status: "ready",
                    projects: sortedProjects,
                    retainedProjects: retainedProjects(projects.value.projects),
                    selectedProjectId,
                    registeringProject: false,
                    stale: false,
                    message: undefined,
                    diagnostics: nonInformationalProtocolDiagnostics(projects.diagnostics),
                }),
            );
        } catch {
            if (generation === this.#loadGeneration) {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: localizedText("library.load_interrupted"),
                        diagnostics: Object.freeze([]),
                    }),
                );
            }
        }
    }

    public selectProject(projectId: string): boolean {
        if (this.#state.status !== "ready" || !this.#state.projects.some((project) => project.projectId === projectId)) {
            return false;
        }
        this.#transition(
            Object.freeze({
                ...this.#state,
                selectedProjectId: projectId,
                message: undefined,
            }),
        );
        return true;
    }

    public async registerProject(localPathSelectionToken: string): Promise<string | undefined> {
        if (
            this.#state.status !== "ready" ||
            this.#state.registeringProject ||
            !this.#client.supportsOperation("project.register") ||
            localPathSelectionToken.trim() === ""
        ) {
            return undefined;
        }
        const generation = ++this.#registrationGeneration;
        this.#transition(
            Object.freeze({
                ...this.#state,
                registeringProject: true,
                message: undefined,
            }),
        );
        try {
            const result = await this.#client.registerProject({ localPathSelectionToken });
            if (generation !== this.#registrationGeneration || this.#state.status !== "ready") return undefined;
            if (result.status === "failed") {
                const feedback = outcomeFeedback(result.diagnostics, localizedText("library.project_register_failed"));
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        registeringProject: false,
                        message: feedback.message,
                        diagnostics: nonInformationalProtocolDiagnostics([...this.#state.diagnostics, ...feedback.diagnostics]),
                    }),
                );
                return undefined;
            }
            const projects = activeProjects([...this.#state.projects, result.value]);
            this.#transition(
                Object.freeze({
                    ...this.#state,
                    projects,
                    selectedProjectId: result.value.projectId,
                    registeringProject: false,
                    message: localizedText("library.project_registered", { project: projectDisplayName(result.value) }),
                    diagnostics: nonInformationalProtocolDiagnostics([...this.#state.diagnostics, ...result.diagnostics]),
                }),
            );
            return result.value.projectId;
        } catch {
            if (generation === this.#registrationGeneration && this.#state.status === "ready") {
                this.#transition(
                    Object.freeze({
                        ...this.#state,
                        registeringProject: false,
                        message: localizedText("library.project_register_interrupted"),
                        diagnostics: this.#state.diagnostics,
                    }),
                );
            }
            return undefined;
        }
    }

    public applyLifecycleProject(project: ProjectView): string | undefined {
        if (this.#state.status !== "ready") return undefined;
        const allProjects = [...this.#state.projects, ...this.#state.retainedProjects].filter(
            (candidate) => candidate.projectId !== project.projectId,
        );
        allProjects.push(project);
        const projects = activeProjects(allProjects);
        const nextSelectedProjectId = project.deleted
            ? chooseInitialProjectId(projects, this.#state.selectedProjectId)
            : project.projectId;
        this.#transition(
            Object.freeze({
                ...this.#state,
                projects,
                retainedProjects: retainedProjects(allProjects),
                selectedProjectId: nextSelectedProjectId,
                stale: false,
                message: undefined,
            }),
        );
        return nextSelectedProjectId;
    }

    #ensureInvalidationSubscription(): void {
        this.#unsubscribeInvalidation ??= this.#client.subscribeInvalidation((invalidation) =>
            this.#handleInvalidation(invalidation),
        );
    }

    #handleInvalidation(invalidation: ProtocolInvalidationV1): void {
        if (this.#state.status !== "ready") return;
        const relevant =
            invalidation.resourceKind === "project" ||
            invalidation.resourceKind === "asset" ||
            (invalidation.resourceKind === "collection" &&
                (invalidation.collection === "projects" || invalidation.collection === "assets"));
        if (!relevant) return;
        this.#transition(
            Object.freeze({
                ...this.#state,
                stale: true,
                message: undefined,
            }),
        );
    }

    #transition(state: ProjectLibraryState): void {
        this.#state = state;
        for (const listener of this.#listeners) listener(state);
    }
}
