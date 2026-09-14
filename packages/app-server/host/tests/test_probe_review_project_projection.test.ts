import { describe, expect, it } from "vitest";
import { projectProbeProjectRows } from "../src/probe-review-project-projection";
import { h2ProbeResult } from "./support/h2-review-fixtures";

describe("Host probe Project source containment projection", () => {
    it("keeps exact workspace identity while projecting nested sources and excluding disjoint roots", () => {
        const probe = h2ProbeResult();
        const workspace = probe.observation.sourceRoots[0];
        if (workspace === undefined) throw new Error("workspace source is required");
        probe.observation.sourceRoots.push(
            {
                ...workspace,
                sourceRootId: "nested-source-root",
                path: "/project/.claude/skills",
            },
            {
                ...workspace,
                sourceRootId: "unrelated-source-root",
                path: "/unrelated/skills",
            },
        );

        expect(projectProbeProjectRows(probe, ["workspace-row", "nested-row", "unrelated-row"], ["project-row"])).toEqual([
            expect.objectContaining({
                rowId: "project-row",
                workspaceSourceRowIds: ["workspace-row"],
                containedSourceRootRowIds: ["workspace-row", "nested-row"],
            }),
        ]);
    });
});
