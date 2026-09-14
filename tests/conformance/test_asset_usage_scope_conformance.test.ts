/** Actual Provider scope declarations must survive Core's read-only candidate projection. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { antigravityProvider } from "../../packages/adapter/providers/antigravity/src/antigravity-provider";
import { cursorProvider } from "../../packages/adapter/providers/cursor/src/cursor-provider";
import { opencodeProvider } from "../../packages/adapter/providers/opencode/src/opencode-provider";
import { publishInitialAssetVersion } from "../../packages/core/src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../packages/core/src/catalog/version-dialect-registry";
import { clearRegistry } from "../../packages/core/src/orchestration/adapter-registry";
import { assetUsageCapableConsumerIds } from "../../packages/core/src/orchestration/asset-usage-analysis";
import { createCoreServiceForTest } from "../../packages/core/src/orchestration/core-service";
import { closeDb } from "../../packages/core/src/persistence/db";
import { resolveObservedNativeProjectTargetContextAsyncWithSnapshot } from "../../packages/core/src/render/native-project-guidance-observation";
import * as renderCompiler from "../../packages/core/src/render/render-compiler";
import * as renderMaterialization from "../../packages/core/src/render/render-materialization";
import type { AnalyzeAssetUsageInput, ProbeResult } from "../../packages/core/src/types";
import {
    ASSET_ID,
    makeAsset,
    makeTextFile,
    makeVersionClosure,
    VERSION_ID,
} from "../../packages/core/tests/catalog/fixtures/version-v2";

describe("Asset usage exact declaration scope", () => {
    const antigravity = { ...antigravityProvider, enabled: true };
    const runtimes = ["ANTIGRAVITY_APP", "ANTIGRAVITY_CLI", "ANTIGRAVITY_IDE"] as const;
    let sandbox = "";
    let targetRoot = "";
    let oaamRoot = "";

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-asset-usage-scope-"));
        targetRoot = path.join(sandbox, "target");
        oaamRoot = path.join(sandbox, "oaam");
        fs.mkdirSync(targetRoot);
        clearRegistry();
        closeDb();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        closeDb();
        clearRegistry();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it("keeps Global Guidance App/IDE candidates without making the project-only CLI poison their shared analysis", () => {
        expect(assetUsageCapableConsumerIds([antigravity], runtimes, ["Guidance"], "global")).toEqual([
            "ANTIGRAVITY_APP",
            "ANTIGRAVITY_IDE",
        ]);
        expect(assetUsageCapableConsumerIds([antigravity], runtimes, ["Guidance"], "project")).toEqual(runtimes);
    });

    it("retains the CLI's own Global Skill support without lending it to Guidance or Rule", () => {
        expect(assetUsageCapableConsumerIds([antigravity], runtimes, ["Skill"], "global")).toEqual(runtimes);
        expect(assetUsageCapableConsumerIds([antigravity], runtimes, ["Skill"], "project")).toEqual(runtimes);
        expect(assetUsageCapableConsumerIds([antigravity], runtimes, ["Rule"], "global")).toEqual([]);
    });

    it("does not infer Global Guidance from either OpenCode entry's project declaration", () => {
        const opencode = { ...opencodeProvider, enabled: true };
        const entries = opencode.agentRuntimes.map((runtime) => runtime.agentRuntimeId);
        expect(assetUsageCapableConsumerIds([opencode], entries, ["Guidance"], "project")).toEqual(entries);
        expect(assetUsageCapableConsumerIds([opencode], entries, ["Guidance"], "global")).toEqual([]);
        expect(assetUsageCapableConsumerIds([opencode], entries, ["Skill"], "global")).toEqual(entries);
    });

    it("does not send a Global Guidance Asset to either Cursor entry's project-only declaration", () => {
        const cursor = { ...cursorProvider, enabled: true };
        const entries = cursor.agentRuntimes.map((runtime) => runtime.agentRuntimeId);
        expect(assetUsageCapableConsumerIds([cursor], entries, ["Guidance"], "project")).toEqual(entries);
        expect(assetUsageCapableConsumerIds([cursor], entries, ["Guidance"], "global")).toEqual([]);
    });

    it("completes the grouped Core analysis using actual App/IDE Global declarations and keeps CLI unavailable", async () => {
        const observedMaterialization = vi.spyOn(renderMaterialization, "materializeRenderObservation");
        const deploymentMaterialization = vi.spyOn(renderMaterialization, "materializeRenderDeployment");
        const compile = vi.spyOn(renderCompiler, "compileRenderDeployment");
        const { core, resolveObservedTargetContext, probeAdapters } = globalCore();
        seedGlobalAuthority();
        const before = core.listDeployments({ includeDeleted: true });
        const result = await core.analyzeAssetUsage(globalInput());

        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(result.value.relationships).toEqual([
            expect.objectContaining({ agentRuntimeId: "ANTIGRAVITY_APP", capability: "direct", observedTargetState: "absent" }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_CLI",
                capability: "unavailable",
                observedTargetState: "unknown",
                reasonCodes: ["asset_usage.target_unsupported"],
            }),
            expect.objectContaining({ agentRuntimeId: "ANTIGRAVITY_IDE", capability: "direct", observedTargetState: "absent" }),
        ]);
        expect(resolveObservedTargetContext.mock.calls.map(([input]) => input.agentRuntimeId)).toEqual([
            "ANTIGRAVITY_APP",
            "ANTIGRAVITY_IDE",
        ]);
        expect(probeAdapters).not.toHaveBeenCalled();
        expect(observedMaterialization).toHaveBeenCalledTimes(2);
        expect(deploymentMaterialization).not.toHaveBeenCalled();
        expect(compile).not.toHaveBeenCalled();
        expect(core.listDeployments({ includeDeleted: true })).toEqual(before);
        expect(fs.readdirSync(targetRoot)).toEqual([]);
    });

    it("does not conceal an actual Global-capable entry's failed installation evidence", async () => {
        const { core, probeAdapters } = globalCore();
        seedGlobalAuthority();
        const input = globalInput();
        const app = input.currentProbeResults[0]?.observation.observedAgentRuntimes[0];
        if (app?.agentRuntimeId !== "ANTIGRAVITY_APP") throw new Error("missing App observation fixture");
        app.installationStatus = "unknown";
        const result = await core.analyzeAssetUsage(input);

        expect(result.status).toBe("failed");
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("native_guidance_runtime_unavailable");
        expect(probeAdapters).not.toHaveBeenCalled();
        expect(fs.readdirSync(targetRoot)).toEqual([]);
    });

    function globalCore() {
        const resolveObservedTargetContext = vi.fn(resolveObservedNativeProjectTargetContextAsyncWithSnapshot);
        const probeAdapters = vi.fn(async () => {
            throw new Error("the exact operation-local probe must be reused");
        });
        const core = createCoreServiceForTest(
            {
                providers: [antigravityProvider],
                platformContexts: [{ platform: "wsl", platformInstanceId: "wsl-test", accessRootPath: sandbox }],
                oaamRoot,
                databasePath: path.join(sandbox, "state.db"),
            },
            {
                resolveObservedTargetContext,
                probeAdapters,
            },
        );
        const current = core.getAdapterEnablement();
        if (current.status === "failed") throw new Error("fixture enablement could not be read");
        const enabled = core.replaceAdapterEnablement({
            expectedRevision: current.value.revision,
            expectedSettingFingerprint: current.value.settingFingerprint,
            enabledAdapterIds: ["ANTIGRAVITY"],
            userActionId: "enable-global-analysis-fixture",
        });
        if (enabled.status === "failed") throw new Error(JSON.stringify(enabled.diagnostics));
        return { core, resolveObservedTargetContext, probeAdapters };
    }

    function seedGlobalAuthority() {
        const assetsRoot = path.join(oaamRoot, "assets");
        fs.mkdirSync(assetsRoot, { recursive: true });
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "22222222-2222-4222-8222-222222222222",
            asset: makeAsset([VERSION_ID], { scope: "global", projectId: "", scopePath: "" }),
            version: makeVersionClosure({ files: [makeTextFile("# Global guidance\n", "GUIDANCE.md")] }),
            dialectRegistry: createVersionDialectRegistry([], [], [], []),
        });
    }

    function globalInput(): AnalyzeAssetUsageInput {
        // Deterministic Host-probe observations, not installed-build evidence. All target reads use the owned empty root.
        const probe: ProbeResult = {
            status: "partial",
            observation: {
                adapterId: "ANTIGRAVITY",
                platformContext: { platform: "wsl", platformInstanceId: "wsl-test", accessRootPath: sandbox },
                observedAgentRuntimes: runtimes.map((agentRuntimeId, index) => {
                    const declaration = antigravity.renderContractDeclarations.find(
                        (item) =>
                            item.agentRuntimeId === agentRuntimeId &&
                            item.declarationKind ===
                                (agentRuntimeId === "ANTIGRAVITY_CLI"
                                    ? "native_project_guidance_v1"
                                    : "native_global_guidance_v1"),
                    );
                    const build = declaration?.verifiedBuilds.find((item) => item.platform === "wsl");
                    if (build === undefined) throw new Error(`missing exact scope/build fixture for ${agentRuntimeId}`);
                    return {
                        agentRuntimeId,
                        versionText: build.versionText,
                        installationStatus: "available",
                        projectDiscoveryStatus: "partial",
                        installationEvidence: [
                            {
                                kind: "executable",
                                path: path.join(sandbox, "bin", agentRuntimeId),
                                evidenceLevel: "agent_runtime_verified",
                                currentBuildObservation: {
                                    buildIdentity: build.buildIdentity,
                                    byteSize: 5,
                                    executable: true,
                                    identity: { deviceId: "1", fileId: String(index + 1), entryKind: "file" },
                                },
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: [],
                        agentRuntimeResourceIds: [],
                        observedProjectIds: [],
                        diagnostics: [],
                    };
                }),
                sourceRoots: [],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [
                    {
                        targetCandidateId: "global-guidance",
                        targetRootPath: targetRoot,
                        targetKind: "global",
                        displayName: "Global fixture",
                        entryApplicabilities: runtimes.map((agentRuntimeId) => ({
                            agentRuntimeId,
                            status: "ready_for_plan",
                            locatorEvidence: [
                                {
                                    locatorKind: "runtime_known_rule",
                                    locatorKey: "global",
                                    evidenceLevel: "agent_runtime_verified",
                                },
                            ],
                            diagnostics: [],
                        })),
                        diagnostics: [],
                    },
                ],
            },
            diagnostics: [],
        };
        return {
            projectId: "",
            consumerAgentRuntimeIds: [...runtimes],
            platform: "wsl",
            platformInstanceId: "wsl-test",
            targetRootPath: targetRoot,
            asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
            currentProbeResults: [probe],
        };
    }
});
