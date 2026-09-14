import { describe, expect, it } from "vitest";
import { presentAssetFilePath } from "../src/renderer/features/asset-content-preview";

describe("Asset file presentation", () => {
    it("replaces only a synthetic canonical root entry with the user-facing Asset identity", () => {
        const asset = { kind: "Guidance", displayName: "demo-architecture" };

        expect(presentAssetFilePath(asset, "GUIDANCE.md")).toBe("demo-architecture");
        expect(presentAssetFilePath(asset, "docs/GUIDANCE.md")).toBe("docs/GUIDANCE.md");
        expect(presentAssetFilePath(asset, "AGENTS.md")).toBe("AGENTS.md");
    });

    it("keeps exact paths when the Asset has no usable display identity", () => {
        expect(presentAssetFilePath({ kind: "Workflow", displayName: "  " }, "WORKFLOW.md")).toBe("WORKFLOW.md");
        expect(presentAssetFilePath({ kind: "Skill", displayName: "Skill" }, "SKILL.md")).toBe("SKILL.md");
    });
});
