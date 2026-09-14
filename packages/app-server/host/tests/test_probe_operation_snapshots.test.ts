import { describe, expect, it } from "vitest";
import { HostProbeOperationSnapshots } from "../src/probe-operation-snapshots";
import { h2ProbeResult as probeResult } from "./support/h2-review-fixtures";

describe("Host probe operation snapshots", () => {
    it("shares one immutable provider set only inside an exact platform context", () => {
        const first = probeResult();
        const sibling = structuredClone(first);
        sibling.observation.adapterId = "SIBLING" as never;
        const otherContext = structuredClone(first);
        otherContext.observation.adapterId = "OTHER" as never;
        otherContext.observation.platformContext.platformInstanceId = "other";
        const snapshots = new HostProbeOperationSnapshots();
        snapshots.record(
            "probe-token",
            [{ rowId: "first" }, { rowId: "sibling" }, { rowId: "other" }],
            [first, sibling, otherContext],
        );

        const firstGroup = snapshots.resolve("probe-token", "first");
        const siblingGroup = snapshots.resolve("probe-token", "sibling");
        const otherGroup = snapshots.resolve("probe-token", "other");
        expect(firstGroup).toBe(siblingGroup);
        expect(firstGroup).toHaveLength(2);
        expect(firstGroup?.map((result) => result.observation.adapterId)).toEqual([first.observation.adapterId, "SIBLING"]);
        expect(Object.isFrozen(firstGroup)).toBe(true);
        expect(Object.isFrozen(firstGroup?.[0])).toBe(true);
        expect(otherGroup).not.toBe(firstGroup);
        expect(otherGroup).toHaveLength(1);

        snapshots.invalidate("probe-token");
        expect(snapshots.resolve("probe-token", "first")).toBeUndefined();
    });

    it("rejects row/result cardinality drift", () => {
        expect(() => new HostProbeOperationSnapshots().record("probe-token", [{ rowId: "only" }], [])).toThrow(
            "rows and results disagree",
        );
    });
});
