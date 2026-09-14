import type { ProtocolDiagnosticV1, ProtocolOperationResult } from "@oaam/app-server-protocol";
import type { WorkbenchRoute } from "../../app/workbench-navigation";
import type { DesktopApplicationClientApi } from "../../client";

type CatalogSearchResultValue = Extract<ProtocolOperationResult<"catalog.search">, { readonly value: unknown }>["value"];

export type CatalogSearchProjectMatch = CatalogSearchResultValue["projects"]["items"][number];
export type CatalogSearchAssetMatch = CatalogSearchResultValue["assets"]["items"][number];

export type CatalogSearchState =
    | { readonly status: "idle" }
    | { readonly status: "loading" }
    | {
          readonly status: "ready";
          readonly value: CatalogSearchResultValue;
          readonly partial: boolean;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      }
    | { readonly status: "failed"; readonly diagnostics: readonly ProtocolDiagnosticV1[] };

export interface CatalogSearchTextSegment {
    readonly text: string;
    readonly matched: boolean;
}

export type CatalogSearchItem =
    | {
          readonly itemKind: "project";
          readonly id: string;
          readonly title: string;
          readonly detail: string;
          readonly snippet: string;
          readonly route: WorkbenchRoute;
          readonly retained: boolean;
      }
    | {
          readonly itemKind: "asset";
          readonly id: string;
          readonly title: string;
          readonly detail: string;
          readonly snippet: string;
          readonly route: WorkbenchRoute | undefined;
      }
    | {
          readonly itemKind: "navigation";
          readonly id: string;
          readonly title: string;
          readonly detail: string;
          readonly route: WorkbenchRoute;
      };

export function boundedCatalogSearchInput(value: string): string {
    return [...value].slice(0, 128).join("");
}

function escapeRegularExpression(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function segmentCatalogSearchText(value: string, query: string): readonly CatalogSearchTextSegment[] {
    const terms = [
        ...new Map(
            query
                .trim()
                .split(/\s+/u)
                .filter((term) => term !== "")
                .map((term) => [term.toLocaleLowerCase("en-US"), term] as const),
        ).values(),
    ].sort((left, right) => right.length - left.length);
    if (value === "" || terms.length === 0) return Object.freeze([{ text: value, matched: false }]);

    const matcher = new RegExp(terms.map(escapeRegularExpression).join("|"), "giu");
    const segments: CatalogSearchTextSegment[] = [];
    let cursor = 0;
    for (const match of value.matchAll(matcher)) {
        const start = match.index;
        const text = match[0];
        if (start > cursor) segments.push(Object.freeze({ text: value.slice(cursor, start), matched: false }));
        segments.push(Object.freeze({ text, matched: true }));
        cursor = start + text.length;
    }
    if (cursor < value.length) segments.push(Object.freeze({ text: value.slice(cursor), matched: false }));
    return segments.length === 0 ? Object.freeze([{ text: value, matched: false }]) : Object.freeze(segments);
}

export function supportsCatalogSearch(client: DesktopApplicationClientApi): boolean {
    return client.supportsOperation("catalog.search");
}

export function catalogSearchAssetRoute(match: CatalogSearchAssetMatch): WorkbenchRoute | undefined {
    if (match.scope === "global") {
        return { surface: "library", subject: "global", assetId: match.assetId };
    }
    if (match.projectId === undefined) return undefined;
    return {
        surface: "library",
        subject: "projects",
        projectId: match.projectId,
        assetId: match.assetId,
    };
}

export function catalogSearchProjectRoute(match: CatalogSearchProjectMatch): WorkbenchRoute {
    return { surface: "library", subject: "projects", projectId: match.projectId };
}
