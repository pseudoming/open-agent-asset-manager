import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../client";
import {
    localizedText,
    nonInformationalProtocolDiagnostics,
    protocolFeedback,
    type DesktopDisplayText,
    type ProtocolFeedback,
} from "../../presentation";
import { ASSET_KIND_ORDER, type AssetKindView, type AssetSummaryView, type ProjectLibrarySubject } from "./project-library-model";

export type AssetBrowserCollectionId = "project" | "global";

export type AssetKindPageState =
    | { readonly status: "collapsed"; readonly kind: AssetKindView; readonly totalCount: number }
    | { readonly status: "loading"; readonly kind: AssetKindView; readonly totalCount: number }
    | {
          readonly status: "ready";
          readonly kind: AssetKindView;
          readonly totalCount: number;
          readonly assets: readonly AssetSummaryView[];
          readonly hasMore: boolean;
          readonly nextCursor?: string;
          readonly loadingMore?: boolean;
      }
    | {
          readonly status: "failed";
          readonly kind: AssetKindView;
          readonly totalCount: number;
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      };

export interface AssetBrowserCollectionState {
    readonly collectionId: AssetBrowserCollectionId;
    readonly subject: { readonly scope: "global" } | { readonly scope: "project"; readonly projectId: string };
    readonly kinds: readonly AssetKindPageState[];
    readonly totalCount: number;
}

export type AssetBrowserState =
    | { readonly status: "idle" | "loading" }
    | {
          readonly status: "failed";
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      }
    | {
          readonly status: "ready";
          readonly collections: readonly AssetBrowserCollectionState[];
          readonly keywords: string;
          readonly includeDeleted: boolean;
          readonly refreshing?: boolean;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      };

function failureFeedback(diagnostics: readonly ProtocolDiagnosticV1[]): ProtocolFeedback {
    return protocolFeedback(localizedText("library.load_failed"), diagnostics);
}

export class AssetBrowserController {
    readonly #client: DesktopApplicationClientApi;
    readonly #listeners = new Set<(state: AssetBrowserState) => void>();
    #state: AssetBrowserState = Object.freeze({ status: "idle" });
    #generation = 0;

    public constructor(client: DesktopApplicationClientApi) {
        this.#client = client;
    }

    public get state(): AssetBrowserState {
        return this.#state;
    }

    public subscribe(listener: (state: AssetBrowserState) => void): () => void {
        this.#listeners.add(listener);
        listener(this.#state);
        return () => this.#listeners.delete(listener);
    }

    public dispose(): void {
        this.#generation += 1;
        this.#listeners.clear();
    }

    public async load(
        subject: ProjectLibrarySubject,
        projectId: string | undefined,
        keywords: string,
        includeDeleted: boolean,
    ): Promise<void> {
        const generation = ++this.#generation;
        if (
            !this.#client.supportsOperation("asset_library.kind_counts") ||
            !this.#client.supportsOperation("asset_library.page") ||
            (subject === "projects" && projectId === undefined)
        ) {
            this.#transition(
                subject === "projects" && projectId === undefined
                    ? Object.freeze({ status: "idle" })
                    : Object.freeze({
                          status: "failed",
                          message: localizedText("library.operation_unavailable"),
                          diagnostics: Object.freeze([]),
                      }),
            );
            return;
        }
        this.#transition(Object.freeze({ status: "loading" }));
        const subjects =
            subject === "global"
                ? ([{ collectionId: "global", subject: { scope: "global" } }] as const)
                : ([{ collectionId: "project", subject: { scope: "project", projectId: projectId as string } }] as const);
        try {
            const outcomes = await Promise.all(
                subjects.map(async (entry) => ({
                    entry,
                    outcome: await this.#client.listAssetKindCounts({
                        subject: entry.subject,
                        keywords,
                        includeDeleted,
                    }),
                })),
            );
            if (generation !== this.#generation) return;
            const failure = outcomes.find(({ outcome }) => outcome.status === "failed");
            if (failure?.outcome.status === "failed") {
                this.#transition(Object.freeze({ status: "failed", ...failureFeedback(failure.outcome.diagnostics) }));
                return;
            }
            const collections = outcomes.map(({ entry, outcome }) => {
                if (outcome.status === "failed") throw new Error("unreachable Asset kind-count failure");
                const counts = new Map(outcome.value.counts.map((item) => [item.kind, item.count] as const));
                const kinds = ASSET_KIND_ORDER.map((kind) =>
                    Object.freeze({
                        status: "collapsed" as const,
                        kind,
                        totalCount: counts.get(kind) ?? 0,
                    }),
                );
                return Object.freeze({
                    collectionId: entry.collectionId,
                    subject: entry.subject,
                    kinds: Object.freeze(kinds),
                    totalCount: kinds.reduce((total, kind) => total + kind.totalCount, 0),
                });
            });
            this.#transition(
                Object.freeze({
                    status: "ready",
                    collections: Object.freeze(collections),
                    keywords,
                    includeDeleted,
                    diagnostics: nonInformationalProtocolDiagnostics(outcomes.flatMap(({ outcome }) => outcome.diagnostics)),
                }),
            );
        } catch {
            if (generation === this.#generation) {
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

    /** Rebuild only the visible pages with fresh catalog cursors, keeping their DOM in place. */
    public async refresh(): Promise<void> {
        const previous = this.#state;
        if (previous.status !== "ready") return;
        const generation = ++this.#generation;
        this.#transition(Object.freeze({ ...previous, refreshing: true }));
        const diagnostics: ProtocolDiagnosticV1[] = [];
        try {
            const collections = await Promise.all(
                previous.collections.map(async (collection) => {
                    const counts = await this.#client.listAssetKindCounts({
                        subject: collection.subject,
                        keywords: previous.keywords,
                        includeDeleted: previous.includeDeleted,
                    });
                    diagnostics.push(...counts.diagnostics);
                    if (counts.status === "failed") throw new Error("Asset counts could not be refreshed");
                    const byKind = new Map(counts.value.counts.map((entry) => [entry.kind, entry.count]));
                    const kinds = await Promise.all(
                        collection.kinds.map(async (kind): Promise<AssetKindPageState> => {
                            const totalCount = byKind.get(kind.kind) ?? 0;
                            if (kind.status !== "ready" && kind.status !== "loading") {
                                return Object.freeze({ status: "collapsed", kind: kind.kind, totalCount });
                            }
                            const limit = kind.status === "ready" ? Math.max(1, kind.assets.length) : 50;
                            const assets: AssetSummaryView[] = [];
                            let cursor: string | undefined;
                            let pagesRemaining = Math.max(1, Math.ceil(limit / 50));
                            do {
                                if (generation !== this.#generation) return kind;
                                const outcome = await this.#client.queryAssetLibrary({
                                    subject: collection.subject,
                                    kind: kind.kind,
                                    keywords: previous.keywords,
                                    includeDeleted: previous.includeDeleted,
                                    pageSize: 50,
                                    ...(cursor === undefined ? {} : { cursor }),
                                });
                                diagnostics.push(...outcome.diagnostics);
                                if (outcome.status === "failed") throw new Error("Asset page could not be refreshed");
                                assets.push(...outcome.value.assets);
                                cursor = outcome.value.hasMore ? outcome.value.nextCursor : undefined;
                            } while (cursor !== undefined && --pagesRemaining > 0);
                            return Object.freeze({
                                status: "ready",
                                kind: kind.kind,
                                totalCount,
                                assets: Object.freeze(assets),
                                hasMore: cursor !== undefined,
                                ...(cursor === undefined ? {} : { nextCursor: cursor }),
                            });
                        }),
                    );
                    return Object.freeze({
                        ...collection,
                        kinds: Object.freeze(kinds),
                        totalCount: kinds.reduce((total, kind) => total + kind.totalCount, 0),
                    });
                }),
            );
            if (generation !== this.#generation) return;
            this.#transition(
                Object.freeze({
                    ...previous,
                    refreshing: false,
                    collections: Object.freeze(collections),
                    diagnostics: nonInformationalProtocolDiagnostics(diagnostics),
                }),
            );
        } catch {
            if (generation !== this.#generation) return;
            this.#generation += 1;
            this.#transition(
                Object.freeze({
                    status: "failed",
                    ...(diagnostics.length > 0
                        ? failureFeedback(diagnostics)
                        : { message: localizedText("library.load_interrupted"), diagnostics: Object.freeze([]) }),
                }),
            );
        }
    }

    public async loadKind(collectionId: AssetBrowserCollectionId, kind: AssetKindView): Promise<void> {
        if (this.#state.status !== "ready" || this.#state.refreshing) return;
        const collection = this.#state.collections.find((candidate) => candidate.collectionId === collectionId);
        const currentKind = collection?.kinds.find((candidate) => candidate.kind === kind);
        if (
            collection === undefined ||
            currentKind === undefined ||
            currentKind.status === "loading" ||
            (currentKind.status === "ready" && currentKind.loadingMore)
        )
            return;
        const generation = this.#generation;
        const cursor = currentKind.status === "ready" && currentKind.hasMore ? currentKind.nextCursor : undefined;
        if (currentKind.status === "ready" && !currentKind.hasMore) return;
        this.#replaceKind(
            collectionId,
            kind,
            currentKind.status === "ready"
                ? { ...currentKind, loadingMore: true }
                : { status: "loading", kind, totalCount: currentKind.totalCount },
        );
        try {
            const outcome = await this.#client.queryAssetLibrary({
                subject: collection.subject,
                kind,
                keywords: this.#state.status === "ready" ? this.#state.keywords : "",
                includeDeleted: this.#state.status === "ready" ? this.#state.includeDeleted : false,
                pageSize: 50,
                ...(cursor === undefined ? {} : { cursor }),
            });
            if (generation !== this.#generation || this.#state.status !== "ready") return;
            if (outcome.status === "failed") {
                this.#replaceKind(collectionId, kind, {
                    status: "failed",
                    kind,
                    totalCount: currentKind.totalCount,
                    ...failureFeedback(outcome.diagnostics),
                });
                return;
            }
            const previous = currentKind.status === "ready" ? currentKind.assets : [];
            this.#replaceKind(
                collectionId,
                kind,
                {
                    status: "ready",
                    kind,
                    totalCount: outcome.value.totalCount,
                    assets: Object.freeze([...previous, ...outcome.value.assets]),
                    hasMore: outcome.value.hasMore,
                    ...(outcome.value.hasMore ? { nextCursor: outcome.value.nextCursor } : {}),
                },
                nonInformationalProtocolDiagnostics(outcome.diagnostics),
            );
        } catch {
            if (generation === this.#generation) {
                this.#replaceKind(collectionId, kind, {
                    status: "failed",
                    kind,
                    totalCount: currentKind.totalCount,
                    message: localizedText("library.load_interrupted"),
                    diagnostics: Object.freeze([]),
                });
            }
        }
    }

    #replaceKind(
        collectionId: AssetBrowserCollectionId,
        kind: AssetKindView,
        nextKind: AssetKindPageState,
        diagnostics: readonly ProtocolDiagnosticV1[] = [],
    ): void {
        if (this.#state.status !== "ready") return;
        this.#transition(
            Object.freeze({
                ...this.#state,
                diagnostics: nonInformationalProtocolDiagnostics([...this.#state.diagnostics, ...diagnostics]),
                collections: Object.freeze(
                    this.#state.collections.map((collection) =>
                        collection.collectionId === collectionId
                            ? Object.freeze({
                                  ...collection,
                                  kinds: Object.freeze(
                                      collection.kinds.map((candidate) => (candidate.kind === kind ? nextKind : candidate)),
                                  ),
                              })
                            : collection,
                    ),
                ),
            }),
        );
    }

    #transition(state: AssetBrowserState): void {
        this.#state = state;
        for (const listener of this.#listeners) listener(state);
    }
}
