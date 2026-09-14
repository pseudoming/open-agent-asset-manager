/** Formal analyzeAssetUsage over the serialized Target service with an owned physical Linux tree. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as physicalPaths from "@oaam/shared/paths";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as renderAssetAuthority from "../../src/orchestration/deployment-render-asset-authority";
import {
    createRestrictedTargetChannel,
    createRestrictedUsageTargetBinding,
} from "../../src/orchestration/restricted-target-channel";
import type { RestrictedTargetRequest, RestrictedTargetResponse } from "../../src/deployment/restricted-target-contract";
import { createRestrictedTargetService } from "../../src/orchestration/restricted-target-service";
import type {
    SelectedWslTargetExecution,
    SelectedWslUsageTargetRequest,
} from "../../src/orchestration/selected-wsl-target-execution";
import { getDb } from "../../src/persistence/db";
import { getDeployment } from "../../src/persistence/state-db";
import type { AnalyzeAssetUsageInput, UuidV4 } from "../../src/types";
import { ASSET_ID, PROJECT_ID, VERSION_ID } from "../catalog/fixtures/version-v2";
import {
    AGENT_RUNTIME_ID,
    currentProbeResult,
    databasePath,
    DEPLOYMENT_ID,
    provider,
    sandbox,
    seedAuthority,
    service,
    targetRoot,
} from "./fixtures/core-service-render-test-fixtures";

afterEach(() => vi.restoreAllMocks());

function fixture(
    options: { missingUsage?: boolean; mismatch?: boolean; corrupt?: boolean; materializationFailure?: boolean } = {},
) {
    seedAuthority();
    const toHost = (value: string) => `\\\\wsl.localhost\\wsl-test${value.replaceAll("/", "\\")}`;
    const targetRootPath = toHost(targetRoot);
    const loadProjectRoot = renderAssetAuthority.loadProjectRootPath;
    vi.spyOn(renderAssetAuthority, "loadProjectRootPath").mockImplementation((configuration, id) =>
        toHost(loadProjectRoot(configuration, id)),
    );
    const context = { platform: "wsl" as const, platformInstanceId: "wsl-test", accessRootPath: toHost(sandbox) };
    const probe = currentProbeResult();
    probe.observation.platformContext = context;
    for (const runtime of probe.observation.observedAgentRuntimes)
        for (const evidence of runtime.installationEvidence) evidence.path = toHost(evidence.path);
    for (const root of probe.observation.sourceRoots) root.path = toHost(root.path);
    for (const resource of probe.observation.agentRuntimeResources) resource.path = toHost(resource.path);
    for (const candidate of probe.observation.targetCandidates) candidate.targetRootPath = toHost(candidate.targetRootPath);
    const binding = createRestrictedUsageTargetBinding({ platformContext: context, targetRootPath }, randomUUID());
    const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() };
    const target = createRestrictedTargetService({ ...session, bindings: [binding], deadlineAt: Date.now() + 60_000 });
    const requests: RestrictedTargetRequest[] = [];
    const admissions: SelectedWslUsageTargetRequest[] = [];
    let active = false;
    const channel = createRestrictedTargetChannel(session, (request) => {
        expect(active).toBe(true);
        requests.push(structuredClone(request));
        const response: RestrictedTargetResponse = target.handle(JSON.parse(JSON.stringify(request)));
        if (options.corrupt && response.result.kind === "asset_usage") response.result.observations = [];
        return JSON.parse(JSON.stringify(response));
    });
    const withTarget = vi.fn(async () => {
        throw new Error("usage must not acquire a Deployment binding");
    });
    const owner: SelectedWslTargetExecution = {
        withTarget,
        async withUsageTarget(request, run) {
            expect(active).toBe(false);
            admissions.push(request);
            active = true;
            try {
                const execution = channel.bindUsage(binding);
                return await run(
                    options.mismatch
                        ? { ...execution, binding: { ...binding, targetRootPath: `${targetRootPath}\\other` } }
                        : execution,
                );
            } finally {
                active = false;
            }
        },
    };
    if (options.missingUsage) Object.assign(owner, { withUsageTarget: undefined });
    const core = service(
        provider({ materializationFailure: options.materializationFailure }),
        Number.POSITIVE_INFINITY,
        {},
        { platformContexts: [context], selectedWslTargetExecution: owner, newUuid: () => randomUUID() as UuidV4 },
    );
    const input: AnalyzeAssetUsageInput = {
        projectId: PROJECT_ID,
        consumerAgentRuntimeIds: [AGENT_RUNTIME_ID],
        platform: "wsl",
        platformInstanceId: "wsl-test",
        targetRootPath,
        asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
        currentProbeResults: [probe],
    };
    return { core, input, channel, requests, admissions, withTarget, context };
}

describe("ordinary selected-WSL Asset usage operation", () => {
    it("uses one read-only lease per check, sees fresh changes and leaves real Deployment State unchanged", async () => {
        const h = fixture();
        const before = getDeployment(getDb(databasePath), DEPLOYMENT_ID);
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# Project guidance\n");
        const read = vi.spyOn(physicalPaths, "readPlatformContextRegularFileNoFollow");
        const check = () => h.core.analyzeAssetUsage(h.input);
        const first = await check();
        expect(first.status, JSON.stringify(first.diagnostics)).toBe("complete");
        expect(first.value.relationships).toEqual([expect.objectContaining({ observedTargetState: "already_usable" })]);
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# externally changed\n");
        const second = await check();
        expect(second.status, JSON.stringify(second.diagnostics)).toBe("complete");
        expect(second.value.relationships).toEqual([expect.objectContaining({ observedTargetState: "different" })]);
        expect(h.admissions).toEqual(
            Array.from({ length: 2 }, () => ({ platformContext: h.context, targetRootPath: h.input.targetRootPath })),
        );
        expect(h.withTarget).not.toHaveBeenCalled();
        expect(h.requests.map((request) => request.operation.kind)).toEqual(["asset_usage", "asset_usage"]);
        expect(read.mock.calls.every(([input]) => input.filePath.startsWith("/"))).toBe(true);
        expect(read).toHaveBeenCalledTimes(2);
        expect(getDeployment(getDb(databasePath), DEPLOYMENT_ID)).toEqual(before);
    });

    it.each([
        "missingUsage",
        "mismatch",
        "corrupt",
    ] as const)("returns a real failed result for %s without inventing an unknown target", async (failure) => {
        const h = fixture({ [failure]: true });
        const result = await h.core.analyzeAssetUsage(h.input);
        expect(result.status).toBe("failed");
        expect(result.value).toBeUndefined();
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
            failure === "mismatch" ? "render.selected_wsl_usage_mismatch" : "render.selected_wsl_usage_unavailable",
        );
        expect(h.withTarget).not.toHaveBeenCalled();
        expect(h.requests).toHaveLength(failure === "corrupt" ? 1 : 0);
    });

    it("keeps a Provider materialization failure as a per-consumer diagnostic without target reads", async () => {
        const h = fixture({ materializationFailure: true });
        const result = await h.core.analyzeAssetUsage(h.input);
        expect(result.value.relationships).toEqual([expect.objectContaining({ observedTargetState: "unknown" })]);
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("render.materialization_blocked");
        expect(h.requests).toHaveLength(0);
    });
});
