import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProtocolRequest, type ProtocolOperationOutcomeV1 } from "@oaam/app-server-protocol";
import type { CoreService, PlatformContext, ProbeResult } from "@oaam/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    dispatchH2Immediate,
    dispatchH2Long,
    type HostH2DispatchContext,
    type ImmediateH2Request,
    type LongH2Request,
} from "../src/dispatch-h2";
import { HostPathSelectionStore } from "../src/path-selection-store";
import { projectProbeEnvironmentReferences } from "../src/probe-environment-reference-projection";
import { createHostRenderApprovalAuthority } from "../src/render-approval-authority";
import { HostReviewRecordStore } from "../src/review-record-store";
import { HostReviewRecords } from "../src/review-records";
import { complete, fakeCoreWith, required } from "./support/host-test-fixtures";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const rootPath of temporaryRoots.splice(0)) fs.rmSync(rootPath, { recursive: true, force: true });
});

describe("probe environment reference dispatch", () => {
    it("hides only a uniquely corresponding WSL name checked by the same Provider", () => {
        const windows: PlatformContext = { platform: "win32", platformInstanceId: "desktop-local", accessRootPath: "C:\\" };
        const reference = codexWindowsProbeWithUncheckedWslReference(windows, "ubuntu");
        const checked = failedCodexProbeResult({ platform: "wsl", platformInstanceId: "Ubuntu", accessRootPath: "/" });
        const otherProvider = {
            ...checked,
            observation: { ...checked.observation, adapterId: "CLAUDECODE" as ProbeResult["observation"]["adapterId"] },
        };
        expect(projectProbeEnvironmentReferences([reference, otherProvider])).toHaveLength(1);
        expect(projectProbeEnvironmentReferences([reference, checked])).toEqual([]);
        expect(projectProbeEnvironmentReferences([reference, checked, checked])).toEqual([]);
        const alias = failedCodexProbeResult({ platform: "wsl", platformInstanceId: "ubuntu", accessRootPath: "/" });
        expect(projectProbeEnvironmentReferences([reference, checked, alias])).toHaveLength(1);
        expect(reference.observation.environmentReferences?.[0]?.referencedEnvironment.platformInstanceId).toBe("ubuntu");
        expect(checked.observation.platformContext.platformInstanceId).toBe("Ubuntu");
    });

    it("orders multiple unchecked references by their complete public identity", () => {
        const zuluWindows: PlatformContext = {
            platform: "win32",
            platformInstanceId: "zulu-desktop",
            accessRootPath: "C:\\",
        };
        const alphaWindows: PlatformContext = {
            platform: "win32",
            platformInstanceId: "alpha-desktop",
            accessRootPath: "C:\\",
        };

        expect(
            projectProbeEnvironmentReferences([
                codexWindowsProbeWithUncheckedWslReference(zuluWindows, "Zulu"),
                codexWindowsProbeWithUncheckedWslReference(alphaWindows, "Alpine"),
            ]),
        ).toEqual([
            expect.objectContaining({
                originEnvironment: { platform: "win32", platformInstanceId: "alpha-desktop" },
                referencedEnvironment: { platform: "wsl", platformInstanceId: "Alpine" },
            }),
            expect.objectContaining({
                originEnvironment: { platform: "win32", platformInstanceId: "zulu-desktop" },
                referencedEnvironment: { platform: "wsl", platformInstanceId: "Zulu" },
            }),
        ]);
    });

    it("keeps an unchecked Codex App WSL reference behind its owning Windows-only probe token without source authority", async () => {
        const harness = context();
        const windows: PlatformContext = {
            platform: "win32",
            platformInstanceId: "desktop-local",
            accessRootPath: "C:\\",
        };
        const wsl: PlatformContext = {
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            accessRootPath: "\\\\wsl.localhost\\Ubuntu\\",
        };
        const windowsProbe = codexWindowsProbeWithUncheckedWslReference(windows, "Ubuntu");
        const probeAdapters = vi.fn(async () => complete([windowsProbe]));
        const readAssetsFromAdapter = vi.fn();
        const core = fakeCoreWith({
            getAvailablePlatformContexts: () => complete([windows, wsl]),
            probeAdapters,
            readAssetsFromAdapter,
        });

        const probe = await long(
            core,
            createProtocolRequest("codex-windows-only", "adapter.probe", {
                adapterIds: ["CODEX"],
                environments: [{ platform: "win32", platformInstanceId: "desktop-local" }],
                authorization: { scope: "global" },
            }),
            harness.context,
        );
        expect(probeAdapters).toHaveBeenLastCalledWith(
            {
                adapterIds: ["CODEX"],
                contexts: [windows],
                target: { authorizationScope: "global" },
            },
            expect.any(Function),
        );
        expect(probe).toMatchObject({
            status: "complete",
            value: {
                results: [
                    {
                        environment: { platform: "win32", platformInstanceId: "desktop-local" },
                        runtimes: [{ agentRuntimeId: "CODEX_APP" }],
                        sources: [],
                        projects: [],
                        targets: [],
                    },
                ],
            },
        });
        const probeValue = (probe as { value: { probeToken: string; results: Array<{ rowId: string }> } }).value;
        const referenceOutcome = immediate(
            core,
            createProtocolRequest("codex-reference", "probe_environment_reference.list", {
                probeToken: probeValue.probeToken,
            }),
            harness.context,
        );
        expect(referenceOutcome).toEqual({
            status: "complete",
            value: {
                references: [
                    {
                        adapterId: "CODEX",
                        agentRuntimeId: "CODEX_APP",
                        originEnvironment: { platform: "win32", platformInstanceId: "desktop-local" },
                        referencedEnvironment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                        referenceKind: "project",
                        validationState: "not_checked",
                    },
                ],
            },
            diagnostics: [],
        });
        expect(JSON.stringify(referenceOutcome)).not.toMatch(
            /private-reference-id|private-locator-key|codex-windows-config|config\.toml|codex-windows-only/u,
        );

        expect(
            immediate(
                core,
                createProtocolRequest("foreign-reference", "probe_environment_reference.list", {
                    probeToken: probeValue.probeToken,
                }),
                { ...harness.context, connectionId: "another-connection" },
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.review_record_unavailable" }] });

        expect(
            await long(
                core,
                createProtocolRequest("reference-is-not-a-source", "adapter.read", {
                    probeToken: probeValue.probeToken,
                    selections: [
                        {
                            probeResultRowId: required(probeValue.results[0], "Windows probe result").rowId,
                            sourceRootRowIds: ["private-reference-id"],
                        },
                    ],
                }),
                harness.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.review_record_member_unavailable" }] });
        expect(readAssetsFromAdapter).not.toHaveBeenCalled();

        const checkedCodexWsl = failedCodexProbeResult(wsl);
        const mixedProbe = harness.context.reviews.recordProbe("connection", [windowsProbe, checkedCodexWsl]);
        expect(
            immediate(
                core,
                createProtocolRequest("checked-reference", "probe_environment_reference.list", {
                    probeToken: mixedProbe.probeToken,
                }),
                harness.context,
            ),
        ).toEqual({ status: "complete", value: { references: [] }, diagnostics: [] });
        harness.store.close();
    });
});

function context(): { readonly context: HostH2DispatchContext; readonly store: HostReviewRecordStore } {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-host-probe-environment-reference-"));
    temporaryRoots.push(rootPath);
    let pathNumber = 0;
    let recordNumber = 0;
    let memberNumber = 0;
    const store = new HostReviewRecordStore({
        rootPath,
        createToken: () => `review-${++recordNumber}`,
    });
    return {
        store,
        context: {
            connectionId: "connection",
            pathSelections: new HostPathSelectionStore({ createToken: () => `path-${++pathNumber}` }),
            reviews: new HostReviewRecords(store, () => `member-${++memberNumber}`),
            renderApprovals: createHostRenderApprovalAuthority(() => 1_234),
        },
    };
}

function immediate(
    core: CoreService,
    request: ReturnType<typeof createProtocolRequest>,
    dispatchContext: HostH2DispatchContext,
): ProtocolOperationOutcomeV1<unknown> {
    const response = dispatchH2Immediate(core, request as ImmediateH2Request, dispatchContext);
    if (!("result" in response)) throw new TypeError("expected an immediate result");
    return response.result as ProtocolOperationOutcomeV1<unknown>;
}

async function long(
    core: CoreService,
    request: ReturnType<typeof createProtocolRequest>,
    dispatchContext: HostH2DispatchContext,
): Promise<ProtocolOperationOutcomeV1<unknown>> {
    return (await dispatchH2Long(core, request as LongH2Request, dispatchContext)) as ProtocolOperationOutcomeV1<unknown>;
}

function codexWindowsProbeWithUncheckedWslReference(windows: PlatformContext, referencedPlatformInstanceId: string): ProbeResult {
    return {
        status: "complete",
        observation: {
            adapterId: "CODEX" as ProbeResult["observation"]["adapterId"],
            platformContext: windows,
            observedAgentRuntimes: [
                {
                    agentRuntimeId: "CODEX_APP",
                    versionText: "0.147.0-alpha.1.2",
                    installationEvidence: [],
                    sourceRootIds: [],
                    agentRuntimeResourceIds: ["codex-windows-config"],
                    observedProjectIds: [],
                    installationStatus: "available",
                    projectDiscoveryStatus: "complete",
                    diagnostics: [],
                },
            ],
            sourceRoots: [],
            agentRuntimeResources: [
                {
                    agentRuntimeResourceId: "codex-windows-config",
                    roles: ["project_registry"],
                    path: "C:\\Users\\user\\.codex\\config.toml",
                    accessStatus: "available",
                    locatorEvidence: [],
                    diagnostics: [],
                },
            ],
            observedProjects: [],
            targetCandidates: [],
            environmentReferences: [
                {
                    referenceId: "private-reference-id",
                    agentRuntimeId: "CODEX_APP",
                    referenceKind: "project",
                    referencedEnvironment: { platform: "wsl", platformInstanceId: referencedPlatformInstanceId },
                    validationState: "not_checked",
                    evidence: {
                        agentRuntimeResourceId: "codex-windows-config",
                        locatorKey: "private-locator-key",
                        evidenceLevel: "local_artifact",
                    },
                },
            ],
        },
        diagnostics: [],
    };
}

function failedCodexProbeResult(platformContext: PlatformContext): ProbeResult {
    return {
        status: "failed",
        observation: {
            adapterId: "CODEX" as ProbeResult["observation"]["adapterId"],
            platformContext,
            observedAgentRuntimes: [],
            sourceRoots: [],
            agentRuntimeResources: [],
            observedProjects: [],
            targetCandidates: [],
        },
        diagnostics: [],
    };
}
