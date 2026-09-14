import * as fs from "node:fs";
import * as path from "node:path";
import * as filesystem from "@oaam/shared/filesystem";
import * as paths from "@oaam/shared/paths";
import { describe, expect, it, vi } from "vitest";
import { physicalIdentityFingerprint } from "../../src/adapters/adapter-read-physical-authority";
import { usageExpectation, usageFixture } from "./fixtures/restricted-target-usage-fixture";

describe("selected-WSL semantic asset usage capture", () => {
    it("reads a shared target once per batch, then freshly reads bytes changed before the next check", () => {
        const h = usageFixture();
        const file = path.join(h.target, "AGENTS.md");
        fs.writeFileSync(file, "# Current\n");
        const read = vi.spyOn(paths, "readPlatformContextRegularFileNoFollow");
        expect(h.review.observeAssetUsageTargets([usageExpectation(), usageExpectation()])).toEqual([
            { observedTargetState: "already_usable", physicalRelation: "distinct_or_not_imported" },
            { observedTargetState: "already_usable", physicalRelation: "distinct_or_not_imported" },
        ]);
        expect(read).toHaveBeenCalledTimes(1);
        expect(read.mock.calls[0]![0]).toMatchObject({ platform: "wsl", filePath: file, accessRootPath: h.target });
        fs.writeFileSync(file, "# Changed\n");
        expect(h.review.observeAssetUsageTargets([usageExpectation()])[0]!.observedTargetState).toBe("different");
        expect(read).toHaveBeenCalledTimes(2);
        expect(h.requests.map((request) => request.operation.kind)).toEqual(["asset_usage", "asset_usage"]);
    });

    it("isolates an actual typed denied read and reuses that failure only within the current batch", () => {
        const h = usageFixture();
        fs.writeFileSync(path.join(h.target, "good.md"), "# Current\n");
        const original = paths.readPlatformContextRegularFileNoFollow;
        let denied = 0;
        vi.spyOn(paths, "readPlatformContextRegularFileNoFollow").mockImplementation((input) => {
            if (input.filePath === path.join(h.target, "denied.md")) {
                denied++;
                throw new filesystem.SafeFilesystemError({
                    message: "controlled denial",
                    failureKind: "permission_denied",
                    operation: "read_regular_file",
                    targetPath: input.filePath,
                });
            }
            return original(input);
        });
        const expectations = [
            usageExpectation("denied.md"),
            usageExpectation("denied.md"),
            usageExpectation("good.md"),
            usageExpectation("missing.md"),
        ];
        const capture = () => {
            const results = h.review.observeAssetUsageTargets(expectations);
            expect(results.map((item) => item.failureStatus)).toEqual([
                "permission_denied",
                "permission_denied",
                undefined,
                undefined,
            ]);
            expect(JSON.stringify(results)).not.toContain("controlled denial");
            return results.map((item) => item.observedTargetState);
        };
        expect(capture()).toEqual(["unknown", "unknown", "already_usable", "absent"]);
        expect(denied).toBe(1);
        expect(h.channel.available).toBe(true);
        expect(capture()).toEqual(["unknown", "unknown", "already_usable", "absent"]);
        expect(denied).toBe(2);
    });

    it("retains complete leaf membership, explicit empty directories and executable mode", () => {
        const h = usageFixture();
        fs.mkdirSync(path.join(h.target, "leaf/empty"), { recursive: true });
        fs.writeFileSync(path.join(h.target, "leaf/tool.sh"), "# Current\n", { mode: 0o755 });
        const expectation = {
            ...usageExpectation("leaf/tool.sh"),
            files: [{ ...usageExpectation("leaf/tool.sh").files[0]!, executable: true }],
            directoryBoundaries: [{ relativePath: "leaf", desiredDirectoryPaths: ["leaf", "leaf/empty"] }],
        };
        const observe = () => h.review.observeAssetUsageTargets([expectation])[0]!.observedTargetState;
        expect(observe()).toBe("already_usable");
        fs.chmodSync(path.join(h.target, "leaf/tool.sh"), 0o644);
        expect(observe()).toBe("different");
        fs.chmodSync(path.join(h.target, "leaf/tool.sh"), 0o755);
        fs.rmdirSync(path.join(h.target, "leaf/empty"));
        expect(observe()).toBe("different");
        fs.mkdirSync(path.join(h.target, "leaf/empty"));
        fs.writeFileSync(path.join(h.target, "leaf/stale.txt"), "retained sibling");
        expect(observe()).toBe("different");
    });

    it.each([
        "wsl",
        "linux",
    ] as const)("keeps logical WSL source identity distinct from physical %s identity", (sourcePlatform) => {
        const h = usageFixture();
        const file = path.join(h.target, "AGENTS.md");
        fs.writeFileSync(file, "# Current\n");
        const identity = filesystem.readRegularFileNoFollow(file, 100).identity;
        const expectation = {
            ...usageExpectation(),
            sourceIdentityFingerprints: [physicalIdentityFingerprint(sourcePlatform, identity)],
        };
        expect(h.review.observeAssetUsageTargets([expectation])).toEqual([
            sourcePlatform === "wsl"
                ? { observedTargetState: "already_usable", physicalRelation: "same_context_source" }
                : { observedTargetState: "unknown", physicalRelation: "cross_context_unverified" },
        ]);
    });

    it("does not reuse directory inventory when a real sibling appears during capture", () => {
        const h = usageFixture();
        fs.mkdirSync(path.join(h.target, "leaf"));
        fs.writeFileSync(path.join(h.target, "leaf/AGENTS.md"), "# Current\n");
        const expectation = {
            ...usageExpectation("leaf/AGENTS.md"),
            directoryBoundaries: [{ relativePath: "leaf", desiredDirectoryPaths: ["leaf"] }],
        };
        const original = filesystem.inventoryDirectoryNoFollow;
        let observations = 0;
        vi.spyOn(filesystem, "inventoryDirectoryNoFollow").mockImplementation((root, maximum) => {
            const captured = original(root, maximum);
            if (root === path.join(h.target, "leaf") && observations++ === 0)
                fs.writeFileSync(path.join(root, "drift.txt"), "changed");
            return captured;
        });
        expect(h.review.observeAssetUsageTargets([expectation])[0]!.observedTargetState).toBe("unknown");
        expect(h.review.observeAssetUsageTargets([expectation])[0]!.observedTargetState).toBe("different");
    });

    it.each([
        "kind",
        "outer_field",
        "missing",
        "reordered",
        "fingerprint",
        "item_field",
        "state",
        "relation",
    ])("retires a channel whose usage response has corrupt %s", (damage) => {
        const h = usageFixture((response) => {
            if (response.result.kind !== "asset_usage") throw new Error("expected usage result");
            const result = response.result;
            if (damage === "kind") Object.assign(result, { kind: "preview" });
            if (damage === "outer_field") Object.assign(result, { native: {} });
            if (damage === "missing") result.observations.pop();
            if (damage === "reordered") result.observations.reverse();
            if (damage === "fingerprint") result.observations[0]!.expectationFingerprint = `sha256:${"f".repeat(64)}`;
            if (damage === "item_field") Object.assign(result.observations[0]!, { deploymentId: "forbidden" });
            if (damage === "state") Object.assign(result.observations[0]!.observation, { observedTargetState: "invented" });
            if (damage === "relation")
                Object.assign(result.observations[0]!.observation, { physicalRelation: "same_context_source" });
        });
        expect(() => h.review.observeAssetUsageTargets([usageExpectation("one.md"), usageExpectation("two.md")])).toThrow(
            "asset usage capture failed",
        );
        expect(h.channel.available).toBe(false);
        expect(() => h.review.observeAssetUsageTargets([usageExpectation()])).toThrow("asset usage capture failed");
        expect(h.requests).toHaveLength(1);
    });
});
