import type { ProtocolDiagnosticV1, ProtocolInvalidationV1 } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../client";
import {
    localizedText,
    nonInformationalProtocolDiagnostics,
    protocolFeedback,
    type DesktopDisplayText,
} from "../../presentation";
import {
    buildSourceLibrary,
    type SourceLibraryEnvironment,
    type SourceLibraryIntent,
    type SourceLibraryProject,
    type SourceLibraryProvider,
} from "./source-library-model";

export type SourceLibraryState =
    | { readonly status: "loading"; readonly message: DesktopDisplayText }
    | {
          readonly status: "failed";
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      }
    | {
          readonly status: "ready";
          readonly environments: readonly SourceLibraryEnvironment[];
          readonly providers: readonly SourceLibraryProvider[];
          readonly intent: SourceLibraryIntent;
          readonly projects: readonly SourceLibraryProject[];
          readonly stale: boolean;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      };

export class SourceLibraryController {
    readonly #client: DesktopApplicationClientApi;
    readonly #listeners = new Set<(state: SourceLibraryState) => void>();
    #state: SourceLibraryState = Object.freeze({ status: "loading", message: localizedText("sources.loading") });
    #generation = 0;
    #unsubscribeInvalidation: (() => void) | undefined;

    public constructor(client: DesktopApplicationClientApi) {
        this.#client = client;
    }

    public get state(): SourceLibraryState {
        return this.#state;
    }

    public subscribe(listener: (state: SourceLibraryState) => void): () => void {
        this.#listeners.add(listener);
        listener(this.#state);
        return () => this.#listeners.delete(listener);
    }

    public dispose(): void {
        this.#generation += 1;
        this.#unsubscribeInvalidation?.();
        this.#unsubscribeInvalidation = undefined;
        this.#listeners.clear();
    }

    public async load(): Promise<void> {
        const generation = ++this.#generation;
        this.#ensureInvalidationSubscription();
        if (
            !this.#client.supportsOperation("adapter_provider.list") ||
            !this.#client.supportsOperation("watched_scan_intent.get") ||
            !this.#client.supportsOperation("project.list")
        ) {
            this.#transition(
                Object.freeze({
                    status: "failed",
                    message: localizedText("sources.operation_unavailable"),
                    diagnostics: Object.freeze([]),
                }),
            );
            return;
        }
        this.#transition(Object.freeze({ status: "loading", message: localizedText("sources.loading") }));
        try {
            const [providers, intent, projects] = await Promise.all([
                this.#client.listAdapterProviders(),
                this.#client.getWatchedScanIntent(),
                this.#client.listProjects({ includeDeleted: false }),
            ]);
            if (generation !== this.#generation) return;
            const failed = [providers, intent, projects].find((outcome) => outcome.status === "failed");
            if (failed?.status === "failed") {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        ...protocolFeedback(localizedText("sources.load_failed"), failed.diagnostics),
                    }),
                );
                return;
            }
            if (providers.status === "failed" || intent.status === "failed" || projects.status === "failed") {
                throw new Error("unreachable source-library failure");
            }
            this.#transition(
                Object.freeze({
                    status: "ready",
                    environments: buildSourceLibrary(providers.value.providers, intent.value, projects.value.projects),
                    providers: Object.freeze([...providers.value.providers]),
                    intent: intent.value,
                    projects: Object.freeze([...projects.value.projects]),
                    stale: false,
                    diagnostics: nonInformationalProtocolDiagnostics([
                        ...providers.diagnostics,
                        ...intent.diagnostics,
                        ...projects.diagnostics,
                    ]),
                }),
            );
        } catch {
            if (generation === this.#generation) {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: localizedText("sources.load_interrupted"),
                        diagnostics: Object.freeze([]),
                    }),
                );
            }
        }
    }

    #ensureInvalidationSubscription(): void {
        this.#unsubscribeInvalidation ??= this.#client.subscribeInvalidation((invalidation) =>
            this.#handleInvalidation(invalidation),
        );
    }

    #handleInvalidation(invalidation: ProtocolInvalidationV1): void {
        if (this.#state.status !== "ready") return;
        const relevant =
            invalidation.resourceKind === "watched_scan_intent" ||
            invalidation.resourceKind === "project" ||
            (invalidation.resourceKind === "collection" && invalidation.collection === "projects");
        if (!relevant) return;
        this.#transition(Object.freeze({ ...this.#state, stale: true }));
    }

    #transition(state: SourceLibraryState): void {
        this.#state = state;
        for (const listener of this.#listeners) listener(state);
    }
}
