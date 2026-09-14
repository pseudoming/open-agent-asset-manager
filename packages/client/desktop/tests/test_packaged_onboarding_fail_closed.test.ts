import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi } from "@oaam/client-framework";
import { describe, expect, it, vi } from "vitest";
import { provePackagedOnboardingImport } from "../src/renderer/client/packaged-onboarding-proof";

const ASSET_ID = "00000000-0000-4000-8000-000000000011";
const VERSION_ID = "00000000-0000-4000-8000-000000000012";
const FINGERPRINT = "b".repeat(64);
const AVAILABLE_OPERATIONS = Object.freeze([
    "project.list",
    "asset.list",
    "asset.get",
    "asset_version.get",
    "asset_library.kind_counts",
    "asset_library.page",
    "asset_version.list",
    "asset_version.file_children",
    "watched_scan_intent.get",
] as const satisfies readonly ProtocolOperationName[]);

function assetSummary(kind: "Guidance" | "Skill" = "Guidance") {
    return {
        assetId: ASSET_ID,
        kind,
        scope: "global" as const,
        scopePath: "",
        displayName: "Global guidance",
        displayDescription: "Packaged onboarding fixture",
        currentVersionId: VERSION_ID,
        currentRevision: 1,
        currentFingerprint: FINGERPRINT,
        currentVersionStatus: "complete" as const,
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
    };
}

type ProofScenario =
    | "success"
    | "already_enabled"
    | "initialize"
    | "empty_catalog"
    | "provider_status"
    | "provider_inventory"
    | "enablement_read"
    | "enablement_replace"
    | "enablement_replace_missing"
    | "environment_list"
    | "desktop_environment"
    | "ambiguous_desktop_environment"
    | "probe"
    | "probe_result_missing"
    | "config_source"
    | "source_read"
    | "source_read_count"
    | "preview_status"
    | "import_preview"
    | "import_candidate"
    | "candidate_kind"
    | "candidate_freshness"
    | "candidate_bindings"
    | "candidate_bindings_truncated"
    | "import_accept"
    | "import_accept_count"
    | "import_accept_item_status"
    | "final_status"
    | "final_count"
    | "final_catalog"
    | "library_projection";

function failResult(diagnostics: readonly { readonly code: string }[] = []) {
    return {
        status: "failed",
        error: { code: "fixture.failure", message: "fixture failure" },
        diagnostics,
    };
}

function proofConnection(scenario: ProofScenario) {
    let imported = false;
    let assetListCalls = 0;
    const calls: string[] = [];
    const request = vi.fn(async (method: string) => {
        calls.push(method);
        switch (method) {
            case "asset.list": {
                assetListCalls += 1;
                if (assetListCalls === 1 && scenario === "empty_catalog") {
                    return {
                        status: "complete",
                        value: { assets: [assetSummary()] },
                        diagnostics: [],
                    };
                }
                if (assetListCalls > 1 && scenario === "final_status") return failResult();
                return {
                    status: "complete",
                    value: {
                        assets:
                            imported && scenario !== "final_count"
                                ? [assetSummary(scenario === "final_catalog" ? "Skill" : "Guidance")]
                                : [],
                    },
                    diagnostics: [],
                };
            }
            case "adapter_provider.list":
                if (scenario === "provider_status") return failResult();
                return {
                    status: "complete",
                    value: { providers: scenario === "provider_inventory" ? [] : [{ adapterId: "CLAUDECODE" }] },
                    diagnostics: [],
                };
            case "adapter_enablement.get":
                return scenario === "enablement_read"
                    ? failResult()
                    : {
                          status: "complete",
                          value: {
                              revision: 0,
                              settingFingerprint: FINGERPRINT,
                              enabledAdapterIds: scenario === "already_enabled" ? ["CLAUDECODE"] : [],
                          },
                          diagnostics: [],
                      };
            case "adapter_enablement.replace":
                return scenario === "enablement_replace"
                    ? failResult()
                    : {
                          status: "complete",
                          value: {
                              revision: 1,
                              settingFingerprint: FINGERPRINT,
                              enabledAdapterIds: scenario === "enablement_replace_missing" ? [] : ["CLAUDECODE"],
                          },
                          diagnostics: [],
                      };
            case "environment.list":
                return scenario === "environment_list"
                    ? failResult()
                    : {
                          status: "complete",
                          value: {
                              environments:
                                  scenario === "desktop_environment"
                                      ? []
                                      : scenario === "ambiguous_desktop_environment"
                                        ? [
                                              {
                                                  environment: {
                                                      platform: "linux",
                                                      platformInstanceId: "desktop-local",
                                                  },
                                                  displayName: "Local Linux",
                                              },
                                              {
                                                  environment: {
                                                      platform: "win32",
                                                      platformInstanceId: "desktop-local",
                                                  },
                                                  displayName: "Local Windows",
                                              },
                                          ]
                                        : [
                                              {
                                                  environment: {
                                                      platform: "win32",
                                                      platformInstanceId: "desktop-local",
                                                  },
                                                  displayName: "Local Windows",
                                              },
                                          ],
                          },
                          diagnostics: [],
                      };
            case "project.list":
                return scenario === "library_projection"
                    ? failResult()
                    : { status: "complete", value: { projects: [] }, diagnostics: [] };
            case "watched_scan_intent.get":
                return {
                    status: "complete",
                    value: {
                        configVersion: 1,
                        settingId: "watched_scan_intent_v1",
                        revision: 0,
                        environments: [],
                        updatedAt: 0,
                        settingFingerprint: FINGERPRINT,
                    },
                    diagnostics: [],
                };
            case "asset.get":
                return {
                    status: "complete",
                    value: { found: true, value: { ...assetSummary(), versionIds: [VERSION_ID] } },
                    diagnostics: [],
                };
            case "asset_library.kind_counts":
                return {
                    status: "complete",
                    value: {
                        counts: [
                            { kind: "Guidance", count: imported ? 1 : 0 },
                            { kind: "Rule", count: 0 },
                            { kind: "Workflow", count: 0 },
                            { kind: "Skill", count: 0 },
                            { kind: "Subagent", count: 0 },
                            { kind: "Memory", count: 0 },
                        ],
                    },
                    diagnostics: [],
                };
            case "asset_library.page":
                return {
                    status: "complete",
                    value: { assets: imported ? [assetSummary()] : [], totalCount: imported ? 1 : 0, hasMore: false },
                    diagnostics: [],
                };
            case "asset_version.list":
                return {
                    status: "complete",
                    value: {
                        found: true,
                        value: {
                            versions: [
                                {
                                    assetId: ASSET_ID,
                                    versionId: VERSION_ID,
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
                    },
                    diagnostics: [],
                };
            case "asset_version.file_children":
                return {
                    status: "complete",
                    value: { found: true, value: { entries: [], totalCount: 0, hasMore: false } },
                    diagnostics: [],
                };
            case "asset_version.get":
                return {
                    status: "complete",
                    value: {
                        found: true,
                        value: {
                            assetId: ASSET_ID,
                            versionId: VERSION_ID,
                            revision: 1,
                            status: "complete",
                            versionCanonicalContentFingerprint: FINGERPRINT,
                            files: [],
                            createdAt: 1,
                        },
                    },
                    diagnostics: [],
                };
            default:
                throw new Error(`unexpected immediate operation ${method}`);
        }
    });
    const start = vi.fn(async (method: string) => {
        calls.push(method);
        const terminal =
            method === "adapter.probe"
                ? scenario === "probe"
                    ? failResult([
                          { code: "probe.z" },
                          { code: "probe.a" },
                          { code: "probe.z" },
                          { code: "INVALID" },
                          { code: "x".repeat(129) },
                      ])
                    : {
                          status: "partial",
                          value: {
                              probeToken: "probe",
                              results:
                                  scenario === "probe_result_missing"
                                      ? []
                                      : [
                                            {
                                                rowId: "probe-row",
                                                adapterId: "CLAUDECODE",
                                                environment: { platform: "win32", platformInstanceId: "desktop-local" },
                                                sources:
                                                    scenario === "config_source"
                                                        ? []
                                                        : [
                                                              {
                                                                  rowId: "source-row",
                                                                  rootRole: "config",
                                                                  sourceDomain: "agent_runtime_private",
                                                                  accessStatus: "available",
                                                              },
                                                          ],
                                            },
                                        ],
                          },
                          diagnostics: [],
                      }
                : method === "adapter.read"
                  ? {
                        status: scenario === "source_read" ? "partial" : "complete",
                        value: {
                            readToken: "read",
                            candidateCount: scenario === "source_read_count" ? 0 : 1,
                            reports: [],
                        },
                        diagnostics: [],
                    }
                  : method === "import.preview"
                    ? {
                          status: scenario === "preview_status" ? "partial" : "complete",
                          value: {
                              previewToken: "preview",
                              snapshotFingerprint: FINGERPRINT,
                              candidates:
                                  scenario === "import_preview"
                                      ? []
                                      : [
                                            {
                                                candidateId: "candidate",
                                                kind: scenario === "candidate_kind" ? "Skill" : "Guidance",
                                                status: scenario === "import_candidate" ? "blocked" : "importable",
                                                freshness: scenario === "candidate_freshness" ? "stale" : "fresh",
                                                callableBindingRequestCount: scenario === "candidate_bindings" ? 1 : 0,
                                                callableBindingRequestsTruncated: scenario === "candidate_bindings_truncated",
                                            },
                                        ],
                          },
                          diagnostics: [],
                      }
                    : method === "import.accept_batch"
                      ? (() => {
                            imported = true;
                            return scenario === "import_accept"
                                ? failResult()
                                : {
                                      status: "complete",
                                      value: {
                                          items:
                                              scenario === "import_accept_count"
                                                  ? []
                                                  : [
                                                        {
                                                            status:
                                                                scenario === "import_accept_item_status" ? "failed" : "complete",
                                                            candidateId: "candidate",
                                                            version: { assetId: ASSET_ID, versionId: VERSION_ID },
                                                        },
                                                    ],
                                      },
                                      diagnostics: [],
                                  };
                        })()
                      : (() => {
                            throw new Error(`unexpected long operation ${method}`);
                        })();
        return {
            operationId: `operation-${method}`,
            operation: method,
            terminal: Promise.resolve(terminal),
            terminalSequence: null,
            subscribeProgress: () => () => undefined,
        };
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
    return { calls, connection };
}

describe("packaged onboarding fail-closed proof", () => {
    it.each([
        ["initialize", "initialize"],
        ["empty_catalog", "empty_catalog"],
        ["provider_status", "provider_inventory"],
        ["provider_inventory", "provider_inventory"],
        ["enablement_read", "enablement_read"],
        ["enablement_replace", "enablement_replace"],
        ["enablement_replace_missing", "enablement_replace"],
        ["environment_list", "environment_list"],
        ["desktop_environment", "desktop_environment"],
        ["ambiguous_desktop_environment", "desktop_environment"],
        ["probe", "probe"],
        ["probe_result_missing", "config_source"],
        ["config_source", "config_source"],
        ["source_read", "source_read"],
        ["source_read_count", "source_read"],
        ["preview_status", "import_preview"],
        ["import_preview", "import_preview"],
        ["import_candidate", "import_candidate"],
        ["candidate_kind", "import_candidate"],
        ["candidate_freshness", "import_candidate"],
        ["candidate_bindings", "import_candidate"],
        ["candidate_bindings_truncated", "import_candidate"],
        ["import_accept", "import_accept"],
        ["import_accept_count", "import_accept"],
        ["import_accept_item_status", "import_accept"],
        ["final_status", "final_catalog"],
        ["final_count", "final_catalog"],
        ["final_catalog", "final_catalog"],
        ["library_projection", "library_projection"],
    ] satisfies ReadonlyArray<
        readonly [ProofScenario, string]
    >)("stops at %s and never dispatches deployment", async (scenario, expectedStep) => {
        const fixture = proofConnection(scenario);
        await expect(provePackagedOnboardingImport(fixture.connection, () => "user-action")).rejects.toThrow(expectedStep);
        expect(fixture.calls.some((operation) => operation.startsWith("deployment."))).toBe(false);
    });

    it("does not rewrite adapter enablement when Claude Code is already enabled", async () => {
        const fixture = proofConnection("already_enabled");
        await expect(provePackagedOnboardingImport(fixture.connection, () => "user-action")).resolves.toEqual({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
        });
        expect(fixture.calls).not.toContain("adapter_enablement.replace");
    });

    it("returns only bounded, unique and sorted diagnostic codes from a failed proof step", async () => {
        const fixture = proofConnection("probe");
        let failure: unknown;
        try {
            await provePackagedOnboardingImport(fixture.connection, () => "user-action");
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({
            step: "probe",
            diagnosticCodes: ["probe.a", "probe.z"],
        });
    });
});
