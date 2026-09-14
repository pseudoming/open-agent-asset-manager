import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    withAssetUsageTargetOperations,
    withDeploymentTargetOperations,
} from "../../src/orchestration/deployment-target-operations";
import { patchMaterialization } from "./fixtures/restricted-target-container-fixture";
import { usageExpectation, usageFixture } from "./fixtures/restricted-target-usage-fixture";

function selectedConfiguration(h: ReturnType<typeof usageFixture>) {
    const context = {
        platform: "wsl" as const,
        platformInstanceId: h.binding.platformInstanceId,
        accessRootPath: h.binding.targetRootPath,
    };
    const target = {
        platform: "wsl" as const,
        platformInstanceId: context.platformInstanceId,
        targetRootPath: h.binding.targetRootPath,
        deploymentId: randomUUID(),
    };
    const withTarget = vi.fn(async () => {
        throw new Error("unexpected Deployment admission");
    });
    const withUsageTarget = vi.fn(async (_request, run) => run(h.channel.bindUsage(h.binding)));
    return {
        target,
        configuration: { platformContexts: [context], selectedWslTargetExecution: { withTarget, withUsageTarget } },
        withTarget,
        withUsageTarget,
    };
}

describe("operation-bound target composition", () => {
    it("resolves shared container contents and captures complete usage through one read-only lease", async () => {
        const h = usageFixture(),
            selected = selectedConfiguration(h);
        const materialization = await patchMaterialization(h.binding.targetRootPath);
        for (const unit of materialization.units)
            for (const file of unit.files) {
                const target = path.join(h.target, file.relativePath);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(
                    target,
                    file.containerPatch === undefined
                        ? file.content.contentKind === "text"
                            ? file.content.text
                            : file.content.bytes
                        : '{"preserved":42,"instructions":[]}\n',
                );
            }
        await withAssetUsageTargetOperations(selected.configuration, selected.target, async (operations) => {
            const resolved = operations.review.resolveContainerPatches(materialization);
            expect(resolved.status).toBe("complete");
            const capture = await operations.observeUsageTargets([resolved.value]);
            expect(capture[0]!.observedTargetState).toBe("different");
        });
        expect(selected.withUsageTarget).toHaveBeenCalledTimes(1);
        expect(selected.withTarget).not.toHaveBeenCalled();
        expect(h.requests.map((request) => request.operation.kind)).toEqual(["container_patches", "asset_usage"]);
        expect(h.channel.available).toBe(true);
    });

    it("keeps oversized preparation failures in their own rows and batches the remaining B expectations once", async () => {
        const h = usageFixture(),
            selected = selectedConfiguration(h);
        const current = await patchMaterialization(h.binding.targetRootPath);
        const oversized = structuredClone(current);
        oversized.units[0]!.files[0]!.content = { contentKind: "text", text: "x".repeat(4 * 1024 * 1024 + 1) };
        await withAssetUsageTargetOperations(selected.configuration, selected.target, async (operations) => {
            const capture = await operations.observeUsageTargets([oversized, current, oversized, current]);
            expect(capture.map((item) => [item.observedTargetState, item.failureStatus])).toEqual([
                ["unknown", "resource_limit_exceeded"],
                ["absent", undefined],
                ["unknown", "resource_limit_exceeded"],
                ["absent", undefined],
            ]);
            expect(await operations.observeUsageTargets([oversized])).toEqual([capture[0]]);
            expect(await operations.observeUsageTargets([])).toEqual([]);
        });
        expect(h.requests.map((request) => request.operation.kind)).toEqual(["asset_usage"]);
        const operation = h.requests[0]!.operation;
        if (operation.kind !== "asset_usage") throw new Error("usage request missing");
        expect(operation.expectations).toHaveLength(2);
        expect(h.channel.available).toBe(true);
        expect(selected.withTarget).not.toHaveBeenCalled();
    });

    it.each([
        "kind",
        "deployment",
        "instance",
        "mapping",
        "review",
    ])("refuses mismatched %s usage authority without local fallback", async (damage) => {
        const h = usageFixture(),
            selected = selectedConfiguration(h);
        selected.withUsageTarget.mockImplementation(async (_request, run) => {
            const execution = h.channel.bindUsage(h.binding);
            const binding = { ...execution.binding };
            if (damage === "kind") Object.assign(binding, { kind: "deployment" });
            if (damage === "deployment") Object.assign(binding, { deploymentId: selected.target.deploymentId });
            if (damage === "instance") binding.platformInstanceId = "other";
            if (damage === "mapping") binding.executionRootPath = `${h.target}/other`;
            return run({ ...execution, binding, ...(damage === "review" ? { review: undefined } : {}) });
        });
        const run = vi.fn();
        await expect(withAssetUsageTargetOperations(selected.configuration, selected.target, run)).rejects.toThrow(
            "does not own this exact target",
        );
        expect(run).not.toHaveBeenCalled();
        expect(h.requests).toHaveLength(0);
    });

    it("requires a usage owner for selected Windows-to-WSL coordinates", async () => {
        const h = usageFixture(),
            selected = selectedConfiguration(h);
        const run = vi.fn();
        await expect(
            withAssetUsageTargetOperations({ platformContexts: selected.configuration.platformContexts }, selected.target, run),
        ).rejects.toThrow("usage execution is unavailable");
        expect(run).not.toHaveBeenCalled();
    });

    it("uses the existing native implementation and refuses a foreign local root or Deployment", async () => {
        const h = usageFixture();
        const target = {
            platform: "linux" as const,
            platformInstanceId: "local",
            targetRootPath: h.target,
            deploymentId: randomUUID(),
        };
        const configuration = {
            platformContexts: [
                { platform: target.platform, platformInstanceId: target.platformInstanceId, accessRootPath: h.target },
            ],
        };
        fs.writeFileSync(path.join(h.target, "AGENTS.md"), "# Current\n");
        await withDeploymentTargetOperations(configuration, target, (operations) => {
            expect(operations.execution.kind).toBe("host");
            expect(operations.execution.ownsDeployment(target as never)).toBe(true);
            expect(operations.execution.ownsDeployment({ ...target, deploymentId: randomUUID() } as never)).toBe(false);
            expect(operations.execution.ownsDeployment({ ...target, targetRootPath: `${h.target}/foreign` } as never)).toBe(
                false,
            );
            expect(operations.execution.ownsDeployment({ ...target, platformInstanceId: "foreign" } as never)).toBe(false);
            expect(operations.execution.create).toBeTypeOf("function");
            expect(operations.review.observeAssetUsageTargets([usageExpectation()])[0]!.observedTargetState).toBe(
                "already_usable",
            );
            expect(() => operations.review.captureMemoryCatalogTargets([], `${h.target}/foreign`)).toThrow("root mismatch");
            expect(() =>
                operations.review.capturePreWritePreview({ deploymentId: randomUUID(), targetRootPath: h.target } as never),
            ).toThrow("Deployment mismatch");
        });
        await withAssetUsageTargetOperations(configuration, target, async (operations) => {
            await operations.primeUsageFiles([]);
            expect(await operations.observeUsageTargets([])).toEqual([]);
        });
        expect(h.requests).toHaveLength(0);
    });
});
