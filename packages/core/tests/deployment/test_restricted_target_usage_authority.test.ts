import { randomUUID } from "node:crypto";
import * as filesystem from "@oaam/shared/filesystem";
import { describe, expect, it, vi } from "vitest";
import { RESTRICTED_TARGET_PROTOCOL, type RestrictedTargetOperation } from "../../src/deployment/restricted-target-contract";
import { encodeRestrictedGraphPreparation } from "../../src/deployment/restricted-target-graph-codec";
import { encodeRestrictedPreview } from "../../src/deployment/restricted-target-preview-codec";
import * as graphOwner from "../../src/deployment/restricted-target-graph-operation";
import { createRestrictedTargetService } from "../../src/orchestration/restricted-target-service";
import { fixture as graphFixture, FP } from "./fixtures/restricted-target-graph-fixture";
import { makeTestTargetPlan } from "./fixtures/deployment-authority-fixtures";
import { usageExpectation, usageFixture } from "./fixtures/restricted-target-usage-fixture";

describe("usage binding service authority", () => {
    it.each([
        "prepare_graph",
        "execute_graph",
        "continue_graph",
        "recover_graph",
        "preview",
        "inspection_capture",
    ] as const)("rejects a valid %s request before target I/O or graph construction", (kind) => {
        const h = usageFixture();
        const graph = graphFixture(true);
        const operations: Record<typeof kind, RestrictedTargetOperation> = {
            prepare_graph: { kind: "prepare_graph", input: encodeRestrictedGraphPreparation(graph.input) },
            execute_graph: { kind: "execute_graph", preparationId: graph.prepared.preparationId, journal: graph.journal },
            continue_graph: { kind: "continue_graph", journal: graph.journal },
            recover_graph: { kind: "recover_graph", journal: graph.journal, side: "old" },
            preview: {
                kind: "preview",
                input: encodeRestrictedPreview({
                    deploymentId: graph.binding.deploymentId,
                    targetRootPath: h.binding.targetRootPath,
                    renderInputFingerprint: FP,
                    selectionFingerprint: FP,
                    compilationFingerprint: FP,
                    targetPlan: makeTestTargetPlan([
                        { relativePath: "AGENTS.md", content: { contentKind: "text", text: "changed" }, executable: false },
                    ]),
                    baseline: [],
                }),
            },
            inspection_capture: {
                kind: "inspection_capture",
                plan: { compilationFingerprint: FP, outputUnits: [], baselineFiles: [] },
            },
        };
        const inspectRoot = vi.spyOn(filesystem, "confirmDurableDirectoryNoFollow");
        const createGraph = vi.spyOn(graphOwner, "createRestrictedTargetGraphOperation");
        expect(() =>
            h.service.handle({
                protocol: RESTRICTED_TARGET_PROTOCOL,
                ...h.session,
                operationId: randomUUID(),
                sequence: 1,
                bindingId: h.binding.bindingId,
                operation: operations[kind],
            }),
        ).toThrow("read-only usage binding refuses Deployment operations");
        expect(inspectRoot).not.toHaveBeenCalled();
        expect(createGraph).not.toHaveBeenCalled();
        expect(h.review.observeAssetUsageTargets([usageExpectation()])[0]!.observedTargetState).toBe("absent");
    });

    it.each(["kind", "deployment", "foreign"])("rejects a usage binding with invalid %s authority", (damage) => {
        const h = usageFixture();
        const binding = structuredClone(h.binding);
        if (damage === "kind") Object.assign(binding, { kind: "deployment" });
        if (damage === "deployment") Object.assign(binding, { deploymentId: randomUUID() });
        if (damage === "foreign") Object.assign(binding, { executionRootPath: `${h.target}/other` });
        const inspectRoot = vi.spyOn(filesystem, "confirmDurableDirectoryNoFollow");
        expect(() =>
            createRestrictedTargetService({ ...h.session, bindings: [binding], deadlineAt: Date.now() + 60_000 }),
        ).toThrow(/binding|mapping/);
        expect(inspectRoot).not.toHaveBeenCalled();
    });

    it.each([
        "extra_field",
        "bad_expectation",
        "wrong_binding",
    ])("rejects %s before observation and retains a valid next request", (damage) => {
        const h = usageFixture();
        const request = {
            protocol: RESTRICTED_TARGET_PROTOCOL,
            ...h.session,
            operationId: randomUUID(),
            sequence: 1,
            bindingId: h.binding.bindingId,
            operation: { kind: "asset_usage", expectations: [usageExpectation()] },
        };
        if (damage === "extra_field") Object.assign(request.operation, { targetRootPath: "/outside" });
        if (damage === "bad_expectation") Object.assign(request.operation.expectations[0]!, { sourceSnapshot: {} });
        if (damage === "wrong_binding") request.bindingId = randomUUID();
        const inspectRoot = vi.spyOn(filesystem, "confirmDurableDirectoryNoFollow");
        expect(() => h.service.handle(request)).toThrow(/rejected|unapproved/);
        expect(inspectRoot).not.toHaveBeenCalled();
        expect(h.review.observeAssetUsageTargets([usageExpectation()])[0]!.observedTargetState).toBe("absent");
    });
});
