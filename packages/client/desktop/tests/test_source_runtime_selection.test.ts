import { act, cleanup, fireEvent, renderHook, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoverySourceRuntimeSelection } from "../src/renderer/features/discovery/DiscoverySourceRuntimeSelection";
import {
    buildReadSourceRequest,
    classifyDiscoverySources,
    groupDiscoverySourceClaims,
    type AdapterProviderView,
    type ProbeReviewView,
} from "../src/renderer/features/discovery/discovery-model";
import { useDiscoverySourceSelection } from "../src/renderer/features/discovery/use-discovery-source-selection";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { EMPTY_WATCHED, PROBE, PROVIDERS, probeSource, required } from "./discovery-test-fixtures";

afterEach(cleanup);
function fixture() {
    const result = required(PROBE.results[0], "probe result");
    const runtime = required(result.runtimes[0], "runtime");
    const provider = required(PROVIDERS[0], "provider");
    const providers: AdapterProviderView[] = [
        {
            ...provider,
            adapterId: "OPENCODE",
            displayName: "OpenCode",
            agentRuntimes: [
                { agentRuntimeId: "OPENCODE_CLI", displayName: "OpenCode CLI", entryClass: "cli" },
                { agentRuntimeId: "OPENCODE_APP", displayName: "OpenCode App", entryClass: "app" },
            ],
        },
    ];
    const probe: ProbeReviewView = {
        probeToken: "entry-selection",
        results: [
            {
                ...result,
                rowId: "opencode-result",
                adapterId: "OPENCODE",
                runtimes: [
                    { ...runtime, agentRuntimeId: "OPENCODE_CLI", sourceRootRowIds: ["shared", "cli-only"] },
                    { ...runtime, agentRuntimeId: "OPENCODE_APP", sourceRootRowIds: ["shared"] },
                ],
                sources: [probeSource("shared", "shared", "/owned/shared"), probeSource("cli-only", "cli-only", "/owned/cli")],
            },
        ],
    };
    const sources = classifyDiscoverySources(EMPTY_WATCHED, probe);
    const groups = groupDiscoverySourceClaims(sources, probe);
    const shared = required(
        sources.find((source) => source.agentRuntimeIds.length === 2),
        "shared source",
    );
    const group = required(
        groups.find((item) => item.claims.some(({ source }) => source.key === shared.key)),
        "shared group",
    );
    return { probe, providers, sources, groups, shared, group };
}

describe("source interpretation selection", () => {
    it("offers the actual observed entries and forwards an explicit selection or return to all entries", () => {
        const f = fixture();
        const onChange = vi.fn();
        renderWithPresentation(
            createElement(DiscoverySourceRuntimeSelection, {
                group: f.group,
                providers: f.providers,
                selectedSourceKeys: new Set([f.shared.key]),
                choices: new Map(),
                busy: false,
                onChange,
            }),
        );
        fireEvent.click(screen.getByRole("combobox", { name: "Read OpenCode files as" }));
        fireEvent.click(screen.getByRole("option", { name: "OpenCode CLI" }));
        expect(onChange).toHaveBeenLastCalledWith(f.shared.key, "OPENCODE_CLI");
        fireEvent.click(screen.getByRole("combobox", { name: "Read OpenCode files as" }));
        fireEvent.click(screen.getByRole("option", { name: "All discovered entries" }));
        expect(onChange).toHaveBeenLastCalledWith(f.shared.key, undefined);
    });

    it("does not ask for an entry on a source with only one interpretation or one left out of import", () => {
        const f = fixture();
        renderWithPresentation(
            createElement(DiscoverySourceRuntimeSelection, {
                group: f.group,
                providers: f.providers,
                selectedSourceKeys: new Set(),
                choices: new Map(),
                busy: false,
                onChange: vi.fn(),
            }),
        );
        expect(screen.queryByRole("combobox")).toBeNull();
        cleanup();
        const single = required(
            f.sources.find((source) => source.agentRuntimeIds.length === 1),
            "single-entry source",
        );
        const singleGroup = required(
            f.groups.find((group) => group.claims.some(({ source }) => source.key === single.key)),
            "single-entry group",
        );
        renderWithPresentation(
            createElement(DiscoverySourceRuntimeSelection, {
                group: singleGroup,
                providers: f.providers,
                selectedSourceKeys: new Set([single.key]),
                choices: new Map(),
                busy: false,
                onChange: vi.fn(),
            }),
        );
        expect(screen.queryByRole("combobox")).toBeNull();
    });

    it("keeps distinct root selections separate without widening a chosen CLI source back to App", () => {
        const f = fixture();
        const selected = new Set(f.sources.map((source) => source.key));
        const request = buildReadSourceRequest(f.probe, f.sources, selected, new Map([[f.shared.key, "OPENCODE_CLI"]]));
        expect(request).toEqual({
            probeToken: f.probe.probeToken,
            selections: expect.arrayContaining([
                { probeResultRowId: "opencode-result", sourceRootRowIds: ["shared"], agentRuntimeIds: ["OPENCODE_CLI"] },
                { probeResultRowId: "opencode-result", sourceRootRowIds: ["cli-only"] },
            ]),
        });
        expect(request?.selections).toHaveLength(2);
        expect(buildReadSourceRequest(f.probe, f.sources, selected)?.selections).toEqual([
            { probeResultRowId: "opencode-result", sourceRootRowIds: ["cli-only", "shared"] },
        ]);
        expect(buildReadSourceRequest(f.probe, f.sources, selected, new Map([[f.shared.key, "CODEX_CLI"]]))).toBeUndefined();
    });

    it("retains the entry when inclusion changes and resets it for a new probe token", () => {
        const f = fixture();
        const hook = renderHook(({ token }) => useDiscoverySourceSelection(token, f.groups), {
            initialProps: { token: f.probe.probeToken },
        });
        act(() => hook.result.current.onReadAgentRuntimeIdChange(f.shared.key, "OPENCODE_APP"));
        act(() => hook.result.current.onSelectedSourceKeysChange([f.shared.key]));
        expect(hook.result.current.readAgentRuntimeIdsBySource.get(f.shared.key)).toBe("OPENCODE_APP");
        hook.rerender({ token: "fresh-probe" });
        expect(hook.result.current.readAgentRuntimeIdsBySource.size).toBe(0);
        act(() => hook.result.current.onReadAgentRuntimeIdChange(f.shared.key, "OPENCODE_CLI"));
        act(() => hook.result.current.onReadAgentRuntimeIdChange(f.shared.key, undefined));
        expect(hook.result.current.readAgentRuntimeIdsBySource.size).toBe(0);
    });
});
