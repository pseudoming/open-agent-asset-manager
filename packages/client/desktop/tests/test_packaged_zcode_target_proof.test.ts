import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi } from "@oaam/client-framework";
import { describe, expect, it, vi } from "vitest";
import {
    provePackagedZcodeDeploy,
    provePackagedZcodeReverse,
    runPackagedZcodeTargetProof,
} from "../src/renderer/client/packaged-zcode-target-proof";
import { expectPackagedZcodeTargetListenerProtocol } from "./packaged-zcode-target-listener-proof";
import {
    packagedZcodeBrowserPort as browserPort,
    packagedZcodeDeployConnections,
    packagedZcodeSkillPreviewFixture,
    packagedZcodeTargetProtocolFixtures,
    PACKAGED_ZCODE_SOURCE_ROWS,
} from "./packaged-zcode-target-proof-fixtures";

const ASSET_ID = "00000000-0000-4000-8000-000000000041";
const OLD_VERSION_ID = "00000000-0000-4000-8000-000000000042";
const NEW_VERSION_ID = "00000000-0000-4000-8000-000000000043";
const PROJECT_ID = "00000000-0000-4000-8000-000000000044";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000045";
const SOURCE_ASSET_ID = "00000000-0000-4000-8000-000000000046";
const SOURCE_VERSION_ID = "00000000-0000-4000-8000-000000000047";
const SOURCE_PROJECT_ID = "00000000-0000-4000-8000-000000000048";
const UNRELATED_PROJECT_ID = "00000000-0000-4000-8000-000000000049";
const UNRELATED_ASSET_ID = "00000000-0000-4000-8000-000000000050";
const UNRELATED_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000051";
const [FINGERPRINT, FRESH_FINGERPRINT] = ["a".repeat(64), "b".repeat(64)];
const AVAILABLE_OPERATIONS = Object.freeze([
    "project.list",
    "asset.list",
    "asset.get",
    "asset_version.get",
    "asset_library.kind_counts",
    "asset_library.page",
    "asset_version.list",
    "asset_version.file_children",
    "asset.copy",
    "promotion_grant.create",
    "deployment.list",
    "watched_scan_intent.get",
] as const satisfies readonly ProtocolOperationName[]);

const PROJECT = Object.freeze({
    projectId: PROJECT_ID,
    displayName: "OAAM target",
    rootPath: "C:\\oaam-target",
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
});

const SOURCE_PROJECT = Object.freeze({
    projectId: SOURCE_PROJECT_ID,
    displayName: "OAAM source",
    rootPath: "C:\\oaam-source",
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
});

function assetSummary(versionId = OLD_VERSION_ID, kind: "Guidance" | "Workflow" | "Skill" | "Subagent" | "Memory" = "Guidance") {
    return {
        assetId: ASSET_ID,
        kind,
        scope: "project" as const,
        projectId: PROJECT_ID,
        scopePath: "",
        displayName: `Project ${kind.toLowerCase()}`,
        displayDescription: "Packaged ZCode fixture",
        currentVersionId: versionId,
        currentRevision: versionId === OLD_VERSION_ID ? 1 : 2,
        currentFingerprint: FINGERPRINT,
        currentVersionStatus: "complete" as const,
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
    };
}

function deploymentSummary() {
    return {
        deploymentId: DEPLOYMENT_ID,
        subject: { subjectKind: "project" as const, projectId: PROJECT_ID },
        deleted: false,
    };
}

function operation(terminal: unknown) {
    return {
        operationId: "operation",
        operation: "fixture",
        terminal: Promise.resolve(terminal),
        terminalSequence: null,
        subscribeProgress: () => () => undefined,
    };
}

function complete(value: unknown) {
    return { status: "complete", value, diagnostics: [] };
}

function failed(diagnostics: readonly { readonly code: string }[] = []) {
    return { status: "failed", error: { code: "fixture.failure", message: "fixture failure" }, diagnostics };
}

function analysis() {
    return {
        renderInputFingerprint: FINGERPRINT,
        options: [
            {
                optionFingerprint: "c".repeat(64),
                semanticRefFingerprint: "d".repeat(64),
                approvalState: "not_required",
            },
        ],
    };
}

type DeployFailureScenario =
    | "success"
    | "initialize"
    | "empty_state"
    | "provider_inventory"
    | "enablement"
    | "environment"
    | "source_project"
    | "target_project"
    | "source_probe"
    | "source_root"
    | "source_read"
    | "source_preview"
    | "import_accept"
    | "source_version"
    | "asset_copy"
    | "promotion_grant"
    | "target_probe"
    | "deployment_create"
    | "render_selection"
    | "render_preview"
    | "deploy"
    | "inspection"
    | "final_state"
    | "library_projection"
    | "deployment_projection";

function deployConnection(
    options: {
        readonly alreadyEnabled?: boolean;
        readonly scenario?: DeployFailureScenario;
        readonly assetKind?: "Guidance" | "Workflow" | "Skill" | "Subagent" | "Memory";
    } = {},
) {
    const scenario = options.scenario ?? "success";
    const assetKind = options.assetKind ?? "Guidance";
    let imported = false;
    let copied = false;
    let enabled = options.alreadyEnabled ?? false;
    let probeCalls = 0;
    let projectRegistrationCalls = 0;
    let deploymentListCalls = 0;
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const request = vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        switch (method) {
            case "asset.list":
                return complete({
                    assets:
                        scenario === "empty_state" ||
                        (copied && (params as { readonly projectId?: string }).projectId === PROJECT_ID)
                            ? [assetSummary(scenario === "final_state" && imported ? NEW_VERSION_ID : OLD_VERSION_ID, assetKind)]
                            : [],
                });
            case "deployment.list":
                deploymentListCalls += 1;
                return complete({
                    deployments:
                        imported && !(scenario === "deployment_projection" && deploymentListCalls >= 3)
                            ? [deploymentSummary()]
                            : [],
                });
            case "project.list":
                return complete({ projects: [SOURCE_PROJECT, PROJECT] });
            case "watched_scan_intent.get":
                return complete({
                    configVersion: 1,
                    settingId: "watched_scan_intent_v1",
                    revision: 0,
                    environments: [],
                    updatedAt: 0,
                    settingFingerprint: FINGERPRINT,
                });
            case "asset.get":
                return scenario === "library_projection"
                    ? complete({ found: false })
                    : complete({
                          found: true,
                          value: { ...assetSummary(OLD_VERSION_ID, assetKind), versionIds: [OLD_VERSION_ID] },
                      });
            case "asset_library.kind_counts":
                return complete({
                    counts: [
                        {
                            kind: "Guidance",
                            count:
                                assetKind === "Guidance" &&
                                copied &&
                                (params as { readonly subject: { readonly scope: string } }).subject.scope === "project"
                                    ? 1
                                    : 0,
                        },
                        { kind: "Rule", count: 0 },
                        {
                            kind: "Workflow",
                            count:
                                assetKind === "Workflow" &&
                                copied &&
                                (params as { readonly subject: { readonly scope: string } }).subject.scope === "project"
                                    ? 1
                                    : 0,
                        },
                        {
                            kind: "Skill",
                            count:
                                assetKind === "Skill" &&
                                copied &&
                                (params as { readonly subject: { readonly scope: string } }).subject.scope === "project"
                                    ? 1
                                    : 0,
                        },
                        {
                            kind: "Subagent",
                            count:
                                assetKind === "Subagent" &&
                                copied &&
                                (params as { readonly subject: { readonly scope: string } }).subject.scope === "project"
                                    ? 1
                                    : 0,
                        },
                        {
                            kind: "Memory",
                            count:
                                assetKind === "Memory" &&
                                copied &&
                                (params as { readonly subject: { readonly scope: string } }).subject.scope === "project"
                                    ? 1
                                    : 0,
                        },
                    ],
                });
            case "asset_library.page":
                return complete({
                    assets:
                        copied && (params as { readonly subject: { readonly scope: string } }).subject.scope === "project"
                            ? [assetSummary(OLD_VERSION_ID, assetKind)]
                            : [],
                    totalCount:
                        copied && (params as { readonly subject: { readonly scope: string } }).subject.scope === "project"
                            ? 1
                            : 0,
                    hasMore: false,
                });
            case "asset_version.list":
                if ((params as { readonly assetId?: string }).assetId === SOURCE_ASSET_ID) {
                    if (scenario === "source_version") return complete({ found: false });
                    return complete({
                        found: true,
                        value: {
                            versions: [
                                {
                                    assetId: SOURCE_ASSET_ID,
                                    versionId: SOURCE_VERSION_ID,
                                    revision: 1,
                                    status: "complete",
                                    fingerprint: FINGERPRINT,
                                    originAuthorityFingerprint: FRESH_FINGERPRINT,
                                    versionCanonicalContentFingerprint: FINGERPRINT,
                                    changeKind: "create",
                                    sourceVersionId: "",
                                    sourceDeploymentId: "",
                                    changeNote: "",
                                    fileCount: 1,
                                    createdAt: 1,
                                },
                            ],
                            totalCount: 1,
                            hasMore: false,
                        },
                    });
                }
                return complete({
                    found: true,
                    value: {
                        versions: [
                            {
                                assetId: ASSET_ID,
                                versionId: OLD_VERSION_ID,
                                revision: 1,
                                status: "complete",
                                fingerprint: FINGERPRINT,
                                originAuthorityFingerprint: FINGERPRINT,
                                versionCanonicalContentFingerprint: FINGERPRINT,
                                changeKind: "create",
                                sourceVersionId: "",
                                sourceDeploymentId: "",
                                changeNote: "",
                                fileCount: 0,
                                createdAt: 1,
                            },
                        ],
                        totalCount: 1,
                        hasMore: false,
                    },
                });
            case "asset_version.file_children":
                return complete({ found: true, value: { entries: [], totalCount: 0, hasMore: false } });
            case "asset_version.get":
                return complete({
                    found: true,
                    value: {
                        assetId: ASSET_ID,
                        versionId: OLD_VERSION_ID,
                        revision: 1,
                        status: "complete",
                        versionCanonicalContentFingerprint: FINGERPRINT,
                        files: [],
                        createdAt: 1,
                    },
                });
            case "adapter_provider.list":
                return complete({ providers: scenario === "provider_inventory" ? [] : [{ adapterId: "ZCODE" }] });
            case "adapter_enablement.get":
                return complete({ revision: 0, settingFingerprint: FINGERPRINT, enabledAdapterIds: enabled ? ["ZCODE"] : [] });
            case "adapter_enablement.replace":
                enabled = true;
                return complete({
                    revision: 1,
                    settingFingerprint: FINGERPRINT,
                    enabledAdapterIds: scenario === "enablement" ? [] : ["ZCODE"],
                });
            case "environment.list":
                return complete({
                    environments:
                        scenario === "environment"
                            ? []
                            : [
                                  {
                                      environment: { platform: "win32", platformInstanceId: "desktop-local" },
                                      displayName: "Local Windows",
                                  },
                              ],
                });
            case "project.register":
                projectRegistrationCalls += 1;
                if (projectRegistrationCalls === 1) {
                    return scenario === "source_project" ? failed() : complete({ projectId: SOURCE_PROJECT_ID });
                }
                return scenario === "target_project" ? failed() : complete({ projectId: PROJECT_ID });
            case "asset.copy":
                if (scenario === "asset_copy") return failed();
                copied = true;
                return complete({
                    source: { assetId: SOURCE_ASSET_ID, versionId: SOURCE_VERSION_ID },
                    asset: assetSummary(OLD_VERSION_ID, assetKind),
                    version: {
                        assetId: ASSET_ID,
                        versionId: OLD_VERSION_ID,
                        revision: 1,
                        status: "complete",
                        versionCanonicalContentFingerprint: FINGERPRINT,
                        files: [],
                        createdAt: 1,
                    },
                });
            case "promotion_grant.create":
                return scenario === "promotion_grant" ? failed() : complete({ promotionGrantId: "grant" });
            case "deployment.create":
                return scenario === "deployment_create" ? failed() : complete({ deploymentId: DEPLOYMENT_ID });
            default:
                throw new Error(`unexpected immediate operation ${method}`);
        }
    });
    const start = vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        let terminal: unknown;
        switch (method) {
            case "adapter.probe": {
                probeCalls += 1;
                terminal =
                    probeCalls === 1 && scenario === "source_probe"
                        ? failed([
                              { code: "probe.z" },
                              { code: "probe.a" },
                              { code: "probe.z" },
                              { code: "INVALID" },
                              { code: "x".repeat(129) },
                          ])
                        : complete({
                              probeToken: `probe-${probeCalls}`,
                              results: [
                                  {
                                      rowId: `probe-row-${probeCalls}`,
                                      adapterId: "ZCODE",
                                      environment: { platform: "win32", platformInstanceId: "desktop-local" },
                                      sources: probeCalls === 1 && scenario !== "source_root" ? PACKAGED_ZCODE_SOURCE_ROWS : [],
                                      targets:
                                          probeCalls === 2
                                              ? [
                                                    {
                                                        rowId: "target-row",
                                                        targetKind: assetKind === "Memory" ? "directory" : "project",
                                                        displayName:
                                                            assetKind === "Memory"
                                                                ? "ZCode project Memory (target-project-a1b2c3d4)"
                                                                : "OAAM target",
                                                        entryApplicabilities: [
                                                            {
                                                                agentRuntimeId: "ZCODE_APP",
                                                                status:
                                                                    scenario === "target_probe" ? "invalid" : "ready_for_plan",
                                                            },
                                                        ],
                                                    },
                                                ]
                                              : [],
                                  },
                              ],
                          });
                break;
            }
            case "adapter.read":
                terminal = complete({ readToken: "read", candidateCount: scenario === "source_read" ? 0 : 1, reports: [] });
                break;
            case "import.preview":
                terminal = complete({
                    previewToken: "preview",
                    snapshotFingerprint: FINGERPRINT,
                    candidates: [
                        {
                            candidateId: "candidate",
                            kind: assetKind,
                            status: scenario === "source_preview" ? "blocked" : "importable",
                            freshness: "fresh",
                            callableBindingRequestCount: 0,
                            callableBindingRequestsTruncated: false,
                        },
                    ],
                });
                break;
            case "import.accept_batch":
                imported = true;
                terminal =
                    scenario === "import_accept"
                        ? failed()
                        : complete({
                              items: [
                                  {
                                      status: "complete",
                                      candidateId: "candidate",
                                      version: { assetId: SOURCE_ASSET_ID, versionId: SOURCE_VERSION_ID },
                                  },
                              ],
                          });
                break;
            case "deployment.render_analyze":
                terminal = complete(
                    scenario === "render_selection"
                        ? { ...analysis(), options: [{ ...analysis().options[0], approvalState: "required" }] }
                        : analysis(),
                );
                break;
            case "deployment.render_preview":
                terminal = complete(
                    assetKind === "Skill"
                        ? packagedZcodeSkillPreviewFixture()
                        : {
                              previewToken: "render-preview-token",
                              actionState:
                                  scenario === "render_preview" ? "blocked_managed_conflict" : "requires_unmanaged_replacement",
                              files: [{ baselineState: "unmanaged", changeKind: "replace_unmanaged" }],
                          },
                );
                break;
            case "deployment.deploy":
                terminal = complete({ stage: scenario === "deploy" ? "blocked_needs_support" : "in_sync" });
                break;
            case "deployment.inspect_rendered_target":
                terminal = complete({
                    inspectionToken: "inspection",
                    inspectionResultFingerprint: FRESH_FINGERPRINT,
                    changeCount: scenario === "inspection" ? 1 : 0,
                    conflictCount: 0,
                });
                break;
            default:
                throw new Error(`unexpected long operation ${method}`);
        }
        return operation(terminal);
    });
    const connection = {
        state: "created",
        availableOperations: AVAILABLE_OPERATIONS,
        initialize: vi.fn(async () => ({
            protocolVersion: scenario === "initialize" ? 2 : 1,
            hostInstanceId: "host",
            availableOperations: AVAILABLE_OPERATIONS,
        })),
        request,
        start,
        subscribeInvalidation: () => () => undefined,
        subscribeClose: () => () => undefined,
        close: vi.fn(),
    } as unknown as ClientConnectionApi;
    return { connection, calls };
}

type ReverseFailureScenario =
    | "success"
    | "initialize"
    | "initial_state"
    | "inspection"
    | "stale_succeeded"
    | "stale_published"
    | "fresh_inspection"
    | "prepare"
    | "selection"
    | "commit"
    | "recovery"
    | "versions"
    | "final_inspection";

function reverseConnection(
    scenario: ReverseFailureScenario = "success",
    assetKind: "Guidance" | "Workflow" | "Skill" | "Subagent" | "Memory" = "Guidance",
) {
    let committed = false;
    let inspectionCalls = 0;
    let prepareCalls = 0;
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const request = vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        switch (method) {
            case "asset.list":
                return complete({
                    assets:
                        scenario === "initial_state"
                            ? []
                            : [
                                  {
                                      assetId: UNRELATED_ASSET_ID,
                                      kind: assetKind,
                                      currentVersionId: "unrelated-version",
                                  },
                                  {
                                      assetId: ASSET_ID,
                                      kind: assetKind,
                                      currentVersionId:
                                          committed || (scenario === "stale_published" && inspectionCalls >= 1)
                                              ? NEW_VERSION_ID
                                              : OLD_VERSION_ID,
                                  },
                              ],
                });
            case "deployment.list":
                return complete({
                    deployments: [
                        {
                            deploymentId: UNRELATED_DEPLOYMENT_ID,
                            subject: { subjectKind: "project", projectId: UNRELATED_PROJECT_ID },
                            deleted: false,
                        },
                        deploymentSummary(),
                    ],
                });
            case "asset_version.get": {
                const versionId = (params as { readonly versionId: string }).versionId;
                return complete({
                    found: scenario !== "versions" || versionId !== OLD_VERSION_ID,
                    value: { revision: versionId === OLD_VERSION_ID ? 1 : 2 },
                });
            }
            default:
                throw new Error(`unexpected immediate operation ${method}`);
        }
    });
    const start = vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        let terminal: unknown;
        switch (method) {
            case "deployment.inspect_rendered_target": {
                inspectionCalls += 1;
                const expectedChangeCount = assetKind === "Skill" ? 2 : 1;
                terminal = complete({
                    inspectionToken: `inspection-${inspectionCalls}`,
                    inspectionResultFingerprint: FRESH_FINGERPRINT,
                    changeCount:
                        inspectionCalls === 3 && scenario !== "final_inspection"
                            ? 0
                            : inspectionCalls === 2 && scenario === "fresh_inspection"
                              ? 0
                              : expectedChangeCount,
                    conflictCount: inspectionCalls === 1 && scenario === "inspection" ? 1 : 0,
                });
                break;
            }
            case "reverse_accept.prepare":
                prepareCalls += 1;
                terminal =
                    prepareCalls === 1 && scenario !== "stale_succeeded"
                        ? failed([{ code: "reverse.stale_fingerprint" }])
                        : scenario === "prepare" && prepareCalls === 2
                          ? failed()
                          : complete({
                                preparationState: "prepared",
                                preparationId: "preparation",
                                preparationRevision: 1,
                                renderAnalysis:
                                    scenario === "selection"
                                        ? { ...analysis(), options: [{ ...analysis().options[0], approvalState: "required" }] }
                                        : analysis(),
                            });
                break;
            case "reverse_accept.commit":
                committed = true;
                terminal = complete({
                    commitState: scenario === "commit" ? "failed" : "committed",
                    version: { assetId: ASSET_ID, versionId: scenario === "commit" ? OLD_VERSION_ID : NEW_VERSION_ID },
                });
                break;
            case "deployment.recover":
                terminal =
                    scenario === "recovery" ? failed() : complete({ assets: [{ assetId: ASSET_ID, versionId: NEW_VERSION_ID }] });
                break;
            default:
                throw new Error(`unexpected long operation ${method}`);
        }
        return operation(terminal);
    });
    const connection = {
        state: "created",
        availableOperations: [],
        initialize: vi.fn(async () => ({
            protocolVersion: scenario === "initialize" ? 2 : 1,
            hostInstanceId: "host",
            availableOperations: [],
        })),
        request,
        start,
        subscribeInvalidation: () => () => undefined,
        subscribeClose: () => () => undefined,
        close: vi.fn(),
    } as unknown as ClientConnectionApi;
    return { connection, calls };
}

const PROTOCOL = packagedZcodeTargetProtocolFixtures({
    sourceProjectId: SOURCE_PROJECT_ID,
    sourceAssetId: SOURCE_ASSET_ID,
    sourceVersionId: SOURCE_VERSION_ID,
    targetProjectId: PROJECT_ID,
    targetAssetId: ASSET_ID,
    targetVersionId: OLD_VERSION_ID,
    deploymentId: DEPLOYMENT_ID,
    reversedVersionId: NEW_VERSION_ID,
});
const DEPLOY_REQUEST = PROTOCOL.deployRequest;
const DEPLOY_SUBJECTS = PROTOCOL.deploySubjects;
const WORKFLOW_DEPLOY_REQUEST = PROTOCOL.workflow.request;
const WORKFLOW_DEPLOY_SUBJECTS = PROTOCOL.workflow.subjects;
const SUBAGENT_DEPLOY_REQUEST = PROTOCOL.subagent.request;
const SUBAGENT_DEPLOY_SUBJECTS = PROTOCOL.subagent.subjects;
const MEMORY_DEPLOY_REQUEST = PROTOCOL.memory.request;
const MEMORY_DEPLOY_SUBJECTS = PROTOCOL.memory.subjects;
const REVERSE_REQUEST = PROTOCOL.reverseRequest;
const REVERSED_SUBJECT = PROTOCOL.reversedSubject;

describe("packaged ZCode target renderer proof", () => {
    it("imports Guidance, chooses the exact target and deploys through production Protocol operations", async () => {
        const value = deployConnection();
        await expect(
            provePackagedZcodeDeploy(packagedZcodeDeployConnections(value.connection), DEPLOY_REQUEST, () => "user-action"),
        ).resolves.toEqual(DEPLOY_SUBJECTS);
        expect(value.calls.map((call) => call.method)).toEqual([
            "asset.list",
            "deployment.list",
            "adapter_provider.list",
            "adapter_enablement.get",
            "adapter_enablement.replace",
            "environment.list",
            "project.register",
            "project.register",
            "adapter.probe",
            "adapter.read",
            "import.preview",
            "import.accept_batch",
            "asset_version.list",
            "asset.copy",
            "promotion_grant.create",
            "adapter.probe",
            "deployment.create",
            "deployment.render_analyze",
            "deployment.render_preview",
            "deployment.deploy",
            "deployment.inspect_rendered_target",
            "asset.list",
            "deployment.list",
            "project.list",
            "asset_library.kind_counts",
            "asset_library.page",
            "asset.get",
            "asset_version.list",
            "asset_version.file_children",
            "project.list",
            "asset.list",
            "deployment.list",
        ]);
        expect(value.calls.find((call) => call.method === "import.accept_batch")?.params).toMatchObject({
            decisions: [
                {
                    promotion: {
                        promotionAction: "grant_current_version_current_target",
                        target: { targetKind: "project", projectId: SOURCE_PROJECT_ID },
                    },
                },
            ],
        });
        expect(value.calls.find((call) => call.method === "asset.copy")?.params).toMatchObject({
            source: {
                assetId: SOURCE_ASSET_ID,
                versionId: SOURCE_VERSION_ID,
                versionFingerprint: FINGERPRINT,
                originAuthorityFingerprint: FRESH_FINGERPRINT,
            },
            destination: { scope: "project", projectId: PROJECT_ID, scopePath: "" },
            userActionId: "user-action",
        });
        expect(value.calls.find((call) => call.method === "promotion_grant.create")?.params).toMatchObject({
            assetId: ASSET_ID,
            versionId: OLD_VERSION_ID,
            target: { targetKind: "project", projectId: PROJECT_ID },
            userActionId: "user-action",
        });
        expect(value.calls.find((call) => call.method === "deployment.create")?.params).toMatchObject({
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            assets: [{ assetId: ASSET_ID, versionId: OLD_VERSION_ID, allowIncomplete: false }],
        });
        expect(value.calls.find((call) => call.method === "deployment.deploy")?.params).toMatchObject({
            previewToken: "render-preview-token",
            deploymentAction: "replace_unmanaged",
            userActionId: "user-action",
        });
        expect(value.calls.find((call) => call.method === "adapter.read")?.params).toMatchObject({
            selections: [{ sourceRootRowIds: ["source-project-row"] }],
        });
    });

    it.each([
        ["Workflow", WORKFLOW_DEPLOY_REQUEST, WORKFLOW_DEPLOY_SUBJECTS],
        ["Subagent", SUBAGENT_DEPLOY_REQUEST, SUBAGENT_DEPLOY_SUBJECTS],
        ["Memory", MEMORY_DEPLOY_REQUEST, MEMORY_DEPLOY_SUBJECTS],
    ] as const)("carries %s identity through source selection, copy and reviewed deployment", async (kind, request, subjects) => {
        const value = deployConnection({ assetKind: kind });
        await expect(
            provePackagedZcodeDeploy(packagedZcodeDeployConnections(value.connection), request, () => "user-action"),
        ).resolves.toEqual(subjects);
        expect(value.calls.find((call) => call.method === "adapter.read")?.params).toMatchObject({
            selections: [
                {
                    sourceRootRowIds: [kind === "Memory" ? "source-memory-row" : "source-project-row"],
                    allowedKinds: [kind],
                },
            ],
        });
        expect(value.calls.find((call) => call.method === "asset.copy")?.params).toMatchObject({
            displayName: `Packaged ZCode target ${kind}`,
        });
        expect(value.calls.find((call) => call.method === "asset_library.page")?.params).toMatchObject({ kind });
    });

    it("carries the complete Skill graph identity through source selection, import, copy and the reviewed target lifecycle", async () => {
        const value = deployConnection({ assetKind: "Skill" });
        const { request, subjects } = PROTOCOL.skill;
        await expect(
            provePackagedZcodeDeploy(packagedZcodeDeployConnections(value.connection), request, () => "user-action"),
        ).resolves.toEqual(subjects);
        expect(value.calls.find((call) => call.method === "adapter.read")?.params).toMatchObject({
            selections: [{ sourceRootRowIds: ["source-skill-row"], allowedKinds: ["Skill"] }],
        });
        expect(value.calls.find((call) => call.method === "asset.copy")?.params).toMatchObject({
            displayName: "Packaged ZCode target Skill",
        });
        expect(value.calls.find((call) => call.method === "asset_library.page")?.params).toMatchObject({
            kind: "Skill",
        });
    });

    it("does not rewrite enablement when ZCode is already enabled", async () => {
        const value = deployConnection({ alreadyEnabled: true });
        await provePackagedZcodeDeploy(packagedZcodeDeployConnections(value.connection), DEPLOY_REQUEST);
        expect(value.calls.some((call) => call.method === "adapter_enablement.replace")).toBe(false);
    });

    it("keeps source registration, source read, target registration and target deployment on their authorized connections", async () => {
        const value = deployConnection();
        const routes: Array<{ readonly role: string; readonly method: string }> = [];
        const close = vi.fn();
        const connectionFor = (role: string) =>
            ({
                ...value.connection,
                initialize: (...args: Parameters<ClientConnectionApi["initialize"]>) => value.connection.initialize(...args),
                request: async (method: string, params: unknown) => {
                    routes.push({ role, method });
                    return (value.connection.request as (operation: string, value: unknown) => Promise<unknown>)(method, params);
                },
                start: async (method: string, params: unknown) => {
                    routes.push({ role, method });
                    return (value.connection.start as (operation: string, value: unknown) => Promise<unknown>)(method, params);
                },
                close,
            }) as unknown as ClientConnectionApi;
        const connections = [
            connectionFor("source_registration"),
            connectionFor("source"),
            connectionFor("target_registration"),
            connectionFor("target"),
        ];
        const createConnection = vi.fn(() => {
            const connection = connections.shift();
            if (connection === undefined) throw new Error("unexpected Protocol connection");
            return connection;
        });

        await expect(
            runPackagedZcodeTargetProof(
                [browserPort(), browserPort(), browserPort(), browserPort()],
                DEPLOY_REQUEST,
                createConnection,
                () => "request",
            ),
        ).resolves.toEqual({ mode: "deploy", subjects: DEPLOY_SUBJECTS });

        expect(createConnection).toHaveBeenCalledTimes(4);
        expect(routes.filter((route) => route.method === "project.register")).toEqual([
            { role: "source_registration", method: "project.register" },
            { role: "target_registration", method: "project.register" },
        ]);
        expect(routes.filter((route) => route.method === "adapter.read")).toEqual([{ role: "source", method: "adapter.read" }]);
        expect(routes.filter((route) => route.method === "asset.copy")).toEqual([{ role: "target", method: "asset.copy" }]);
        expect(routes.filter((route) => route.method === "deployment.deploy")).toEqual([
            { role: "target", method: "deployment.deploy" },
        ]);
        expect(close).toHaveBeenCalledTimes(4);
    });

    it.each([
        ["initialize", "initialize"],
        ["empty_state", "empty_state"],
        ["provider_inventory", "provider_inventory"],
        ["enablement", "enablement"],
        ["environment", "environment"],
        ["source_project", "source_project"],
        ["target_project", "target_project"],
        ["source_probe", "source_probe"],
        ["source_root", "source_probe"],
        ["source_read", "source_read"],
        ["source_preview", "source_read"],
        ["import_accept", "import_accept"],
        ["source_version", "source_version"],
        ["asset_copy", "asset_copy"],
        ["promotion_grant", "promotion_grant"],
        ["target_probe", "target_probe"],
        ["deployment_create", "deployment_create"],
        ["render_selection", "render_analyze"],
        ["render_preview", "render_preview"],
        ["deploy", "deploy"],
        ["inspection", "inspection"],
        ["final_state", "final_state"],
        ["library_projection", "library_projection"],
        ["deployment_projection", "deployment_projection"],
    ] satisfies ReadonlyArray<
        readonly [DeployFailureScenario, string]
    >)("fails closed at deploy scenario %s", async (scenario, expectedStep) => {
        const value = deployConnection({ scenario });
        await expect(
            provePackagedZcodeDeploy(packagedZcodeDeployConnections(value.connection), DEPLOY_REQUEST, () => "user-action"),
        ).rejects.toThrow(expectedStep);
    });

    it("bounds, sorts and deduplicates diagnostics from the failing operation", async () => {
        const value = deployConnection({ scenario: "source_probe" });
        let failure: unknown;
        try {
            await provePackagedZcodeDeploy(packagedZcodeDeployConnections(value.connection), DEPLOY_REQUEST);
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({ step: "source_probe", diagnosticCodes: ["probe.a", "probe.z"] });
    });

    it("rejects a stale reverse fingerprint before publication, then accepts the fresh snapshot and preserves both versions", async () => {
        const value = reverseConnection();
        await expect(provePackagedZcodeReverse(value.connection, REVERSE_REQUEST, () => "user-action")).resolves.toEqual(
            REVERSED_SUBJECT,
        );
        const prepares = value.calls.filter((call) => call.method === "reverse_accept.prepare");
        expect(prepares).toHaveLength(2);
        expect(prepares[0]?.params).toMatchObject({ inspectionResultFingerprint: "0".repeat(64) });
        expect(prepares[1]?.params).toMatchObject({ inspectionResultFingerprint: FRESH_FINGERPRINT });
        expect(value.calls.find((call) => call.method === "reverse_accept.commit")?.params).toMatchObject({
            newVersionPromotion: "grant_staged_version_current_target",
            userActionId: "user-action",
        });
        expect(value.calls.find((call) => call.method === "deployment.recover")?.params).toEqual({
            deploymentId: DEPLOYMENT_ID,
        });
        expect(value.calls.filter((call) => call.method === "asset_version.get")).toHaveLength(2);
    });

    it("accepts both externally changed Skill graph files through the same stale-snapshot and reviewed reverse path", async () => {
        const value = reverseConnection("success", "Skill");
        const request = Object.freeze({ ...REVERSE_REQUEST, assetKind: "Skill" as const });
        await expect(provePackagedZcodeReverse(value.connection, request, () => "user-action")).resolves.toEqual(
            REVERSED_SUBJECT,
        );
        expect(value.calls.filter((call) => call.method === "deployment.inspect_rendered_target")).toHaveLength(3);
        expect(value.calls.find((call) => call.method === "reverse_accept.commit")?.params).toMatchObject({
            userActionId: "user-action",
        });
    });

    it.each([
        ["initialize", "initialize"],
        ["initial_state", "final_state"],
        ["inspection", "inspection"],
        ["stale_succeeded", "stale_reverse"],
        ["stale_published", "stale_reverse"],
        ["fresh_inspection", "inspection"],
        ["prepare", "reverse_prepare"],
        ["selection", "render_analyze"],
        ["commit", "reverse_commit"],
        ["recovery", "reverse_recover"],
        ["versions", "final_state"],
        ["final_inspection", "final_state"],
    ] satisfies ReadonlyArray<
        readonly [ReverseFailureScenario, string]
    >)("fails closed at reverse scenario %s", async (scenario, expectedStep) => {
        const value = reverseConnection(scenario);
        await expect(provePackagedZcodeReverse(value.connection, REVERSE_REQUEST, () => "user-action")).rejects.toThrow(
            expectedStep,
        );
    });

    it("closes the Client connection after the transport wrapper completes", async () => {
        const value = reverseConnection();
        const port = browserPort();
        const createConnection = vi.fn(() => value.connection);
        await expect(runPackagedZcodeTargetProof([port], REVERSE_REQUEST, createConnection, () => "request")).resolves.toEqual({
            mode: "reverse",
            subject: REVERSED_SUBJECT,
        });
        expect(port.start).toHaveBeenCalledOnce();
        expect(value.connection.close).toHaveBeenCalledOnce();
    });

    it("rejects listener transport errors after the operation and still closes the Client connection", async () => {
        const value = reverseConnection();
        const port = browserPort();
        const createConnection = vi.fn(
            (_transport: unknown, options: { readonly reportListenerError: (error: unknown) => void }) => {
                options.reportListenerError(new Error("listener failed"));
                options.reportListenerError(new Error("second failure"));
                return value.connection;
            },
        );
        await expect(runPackagedZcodeTargetProof([port], REVERSE_REQUEST, createConnection, () => "request")).rejects.toThrow(
            /client_listener/u,
        );
        expect(value.connection.close).toHaveBeenCalledOnce();
    });

    it("reports exact listener failures and ignores unrelated or malformed port deliveries", async () => {
        await expectPackagedZcodeTargetListenerProtocol({
            createReverseConnection: () => reverseConnection().connection,
            createBrowserPort: browserPort,
            reverseRequest: REVERSE_REQUEST,
            reversedSubject: REVERSED_SUBJECT,
        });
    });
});
