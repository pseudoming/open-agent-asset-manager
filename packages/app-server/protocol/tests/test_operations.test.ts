import { describe, expect, it } from "vitest";
import {
    assertProtocolOperationRegistry,
    PROTOCOL_ACCEPTED_LONG_NAMES,
    PROTOCOL_CONTROL_NAMES,
    PROTOCOL_IMMEDIATE_MUTATION_NAMES,
    PROTOCOL_IMMEDIATE_QUERY_NAMES,
    PROTOCOL_OPERATION_NAMES,
    PROTOCOL_OPERATION_REGISTRY,
    type ProtocolOperationDefinition,
    parseProtocolOperationParams,
    parseProtocolOperationProgress,
    parseProtocolOperationResult,
    parseProtocolTerminalOutcome,
    protocolCatalogSearchAssetMatchesSchema,
    protocolCatalogSearchGroupLimitSchema,
    protocolCatalogSearchProjectMatchesSchema,
    protocolCatalogSearchQuerySchema,
    protocolCatalogSearchSnippetSchema,
    protocolDeploymentFreshnessSchema,
    protocolEmptyArraySchema,
    protocolEmptyObjectSchema,
    protocolOperationEventSchema,
    protocolOperationOutcome,
    protocolString,
    validateProtocolOperationRegistry,
} from "../src";
import {
    CATALOG_SEARCH_RESULT,
    completeTerminalValue,
    SHA_B,
    UUID_C,
    VALID_PARAMS,
    VALID_RESULTS,
    VALID_TERMINAL_VALUES,
} from "./fixtures/protocol-fixtures";

describe("closed Protocol operation registry", () => {
    it("contains every exact operation once with its approved delivery class", () => {
        expect(Object.keys(PROTOCOL_OPERATION_REGISTRY).sort()).toEqual([...PROTOCOL_OPERATION_NAMES].sort());
        expect(new Set(PROTOCOL_OPERATION_NAMES).size).toBe(PROTOCOL_OPERATION_NAMES.length);
        expect(validateProtocolOperationRegistry(PROTOCOL_OPERATION_REGISTRY, PROTOCOL_OPERATION_NAMES)).toEqual([]);
        expect(() => assertProtocolOperationRegistry()).not.toThrow();

        for (const name of PROTOCOL_IMMEDIATE_QUERY_NAMES) {
            expect(PROTOCOL_OPERATION_REGISTRY[name].delivery).toBe("immediate_query");
        }
        for (const name of PROTOCOL_IMMEDIATE_MUTATION_NAMES) {
            expect(PROTOCOL_OPERATION_REGISTRY[name].delivery).toBe("immediate_mutation");
        }
        for (const name of PROTOCOL_ACCEPTED_LONG_NAMES) {
            expect(PROTOCOL_OPERATION_REGISTRY[name]).toMatchObject({
                delivery: "accepted_long",
                terminalSchema: expect.any(Object),
                progressSchema: expect.any(Object),
            });
        }
        for (const name of PROTOCOL_CONTROL_NAMES) {
            expect(PROTOCOL_OPERATION_REGISTRY[name].delivery).toBe("control");
        }
    });

    it("strictly parses a valid params and result fixture for every operation", () => {
        for (const name of PROTOCOL_OPERATION_NAMES) {
            expect(parseProtocolOperationParams(name, VALID_PARAMS[name]), `${name} params`).toEqual(VALID_PARAMS[name]);
            expect(parseProtocolOperationResult(name, VALID_RESULTS[name]), `${name} result`).toEqual(VALID_RESULTS[name]);
        }
        expect(() => parseProtocolOperationParams("asset.get", { assetId: "bad" })).toThrow(/UUID/u);
        expect(() => parseProtocolOperationResult("asset.get", { status: "complete", value: null, diagnostics: [] })).toThrow();
    });

    it("binds substitute capability to one structured alternate AssetKind", () => {
        const base = structuredClone(VALID_TERMINAL_VALUES["asset_usage.analyze"]) as {
            relationships: Array<Record<string, unknown>>;
        };
        const relationship = base.relationships[0];
        if (relationship === undefined) throw new Error("asset usage fixture is incomplete");

        const substitute = {
            ...base,
            relationships: [
                {
                    ...relationship,
                    capability: "substitute",
                    observedTargetState: "absent",
                    substitute: { assetKind: "Skill" },
                },
            ],
        };
        expect(
            parseProtocolTerminalOutcome("asset_usage.analyze", {
                status: "complete",
                value: substitute,
                diagnostics: [],
            }),
        ).toMatchObject({ value: { relationships: [{ capability: "substitute", substitute: { assetKind: "Skill" } }] } });

        for (const invalidRelationship of [
            { ...relationship, capability: "substitute", substitute: null },
            { ...relationship, capability: "direct", substitute: { assetKind: "Skill" } },
            { ...relationship, capability: "substitute", substitute: { assetKind: "Plugin" } },
            { ...relationship, observedTargetState: "needs_write" },
        ]) {
            expect(() =>
                parseProtocolTerminalOutcome("asset_usage.analyze", {
                    status: "complete",
                    value: { ...base, relationships: [invalidRelationship] },
                    diagnostics: [],
                }),
            ).toThrow();
        }
    });

    it("accepts only one non-blank installation-root selection token on adapter probe", () => {
        const ordinary = VALID_PARAMS["adapter.probe"];
        expect(
            parseProtocolOperationParams("adapter.probe", {
                ...ordinary,
                installationRootSelectionToken: "installation-token",
            }),
        ).toEqual({ ...ordinary, installationRootSelectionToken: "installation-token" });
        for (const installationRootSelectionToken of ["", " installation-token", null, 1]) {
            expect(() =>
                parseProtocolOperationParams("adapter.probe", {
                    ...ordinary,
                    installationRootSelectionToken,
                }),
            ).toThrow();
        }
    });

    it("authorizes a probe against one registered Project identity without exposing its root", () => {
        const ordinary = VALID_PARAMS["adapter.probe"];
        const registered = {
            ...ordinary,
            authorization: { scope: "registered_project", projectId: UUID_C },
        };
        expect(parseProtocolOperationParams("adapter.probe", registered)).toEqual(registered);
        for (const authorization of [
            { scope: "registered_project" },
            { scope: "registered_project", projectId: "not-a-project" },
            { scope: "registered_project", projectId: UUID_C, localPathSelectionToken: "forged" },
        ]) {
            expect(() => parseProtocolOperationParams("adapter.probe", { ...ordinary, authorization })).toThrow();
        }
    });

    it("bounds catalog search queries and treats snippets as strict plain text", () => {
        expect(protocolCatalogSearchQuerySchema.parse("query")).toBe("query");
        expect(protocolCatalogSearchGroupLimitSchema.parse(8)).toBe(8);
        expect(protocolCatalogSearchSnippetSchema.parse("snippet")).toBe("snippet");
        expect(protocolCatalogSearchProjectMatchesSchema.parse(CATALOG_SEARCH_RESULT.projects.items)).toEqual(
            CATALOG_SEARCH_RESULT.projects.items,
        );
        expect(protocolCatalogSearchAssetMatchesSchema.parse(CATALOG_SEARCH_RESULT.assets.items)).toEqual(
            CATALOG_SEARCH_RESULT.assets.items,
        );
        expect(
            parseProtocolOperationParams("catalog.search", {
                query: "😀".repeat(128),
                limitPerGroup: 20,
            }),
        ).toEqual({ query: "😀".repeat(128), limitPerGroup: 20 });
        for (const params of [
            { query: "" },
            { query: " leading" },
            { query: "line\nbreak" },
            { query: "a\u0085b" },
            { query: "x".repeat(129) },
            { query: "x", limitPerGroup: 0 },
            { query: "x", limitPerGroup: 21 },
            { query: "x", limitPerGroup: 1.5 },
            { query: "x", unknown: true },
        ]) {
            expect(() => parseProtocolOperationParams("catalog.search", params)).toThrow();
        }

        const assetFixture = CATALOG_SEARCH_RESULT.assets.items.at(0);
        const projectFixture = CATALOG_SEARCH_RESULT.projects.items.at(0);
        if (assetFixture === undefined || projectFixture === undefined) throw new Error("catalog search fixture is incomplete");

        const plainText = structuredClone(CATALOG_SEARCH_RESULT);
        plainText.assets.items[0] = { ...assetFixture, snippet: "<script>alert(1)</script>" };
        expect(
            parseProtocolOperationResult("catalog.search", {
                status: "complete",
                value: plainText,
                diagnostics: [],
            }),
        ).toMatchObject({ value: { assets: { items: [{ snippet: "<script>alert(1)</script>" }] } } });

        const tooMany = structuredClone(CATALOG_SEARCH_RESULT);
        tooMany.projects.items = Array.from({ length: 21 }, () => structuredClone(projectFixture));
        expect(() =>
            parseProtocolOperationResult("catalog.search", {
                status: "complete",
                value: tooMany,
                diagnostics: [],
            }),
        ).toThrow(/more than 20/u);

        const longSnippet = structuredClone(CATALOG_SEARCH_RESULT);
        longSnippet.assets.items[0] = { ...assetFixture, snippet: "x".repeat(163) };
        expect(() =>
            parseProtocolOperationResult("catalog.search", {
                status: "complete",
                value: longSnippet,
                diagnostics: [],
            }),
        ).toThrow(/162/u);

        const missingLogicalPath = structuredClone(CATALOG_SEARCH_RESULT);
        const fileMatch = missingLogicalPath.assets.items[0] as Record<string, unknown>;
        delete fileMatch.logicalPath;
        expect(() =>
            parseProtocolOperationResult("catalog.search", {
                status: "complete",
                value: missingLogicalPath,
                diagnostics: [],
            }),
        ).toThrow(/did not match any branch/u);
    });

    it("strictly parses operation-specific State resilience progress", () => {
        expect(
            parseProtocolOperationProgress("state_backup.create", {
                stage: "verification",
                completedUnits: 2,
                totalUnits: 3,
            }),
        ).toEqual({ stage: "verification", completedUnits: 2, totalUnits: 3 });
        expect(() =>
            parseProtocolOperationProgress("state_restore.activate", {
                stage: "packing",
                completedUnits: 1,
                totalUnits: 1,
            }),
        ).toThrow(/expected/u);
    });

    it("preserves the Core-authoritative empty Project display name", () => {
        const result = {
            ...VALID_RESULTS["project.register"],
            value: { ...VALID_RESULTS["project.register"].value, displayName: "" },
        };
        expect(parseProtocolOperationResult("project.register", result)).toEqual(result);
    });

    it("binds all Project lifecycle inspections to one strict review and commit token", () => {
        expect(
            parseProtocolOperationParams("project_lifecycle.inspect", {
                action: "rename",
                projectId: "00000000-0000-4000-8000-000000000001",
                nextDisplayName: "",
            }),
        ).toEqual({
            action: "rename",
            projectId: "00000000-0000-4000-8000-000000000001",
            nextDisplayName: "",
        });
        expect(
            parseProtocolOperationParams("project_lifecycle.inspect", {
                action: "rebind",
                projectId: "00000000-0000-4000-8000-000000000001",
                localPathSelectionToken: "selected-root",
            }),
        ).toEqual({
            action: "rebind",
            projectId: "00000000-0000-4000-8000-000000000001",
            localPathSelectionToken: "selected-root",
        });
        expect(() =>
            parseProtocolOperationParams("project_lifecycle.inspect", {
                action: "rebind",
                projectId: "00000000-0000-4000-8000-000000000001",
                nextRootPath: "/raw-path-is-forbidden",
            }),
        ).toThrow();
        expect(
            parseProtocolOperationParams("project_lifecycle.inspect", {
                action: "restore",
                projectId: "00000000-0000-4000-8000-000000000001",
            }),
        ).toEqual({
            action: "restore",
            projectId: "00000000-0000-4000-8000-000000000001",
        });
        expect(
            parseProtocolOperationParams("project_lifecycle.inspect", {
                action: "stop_managing",
                projectId: "00000000-0000-4000-8000-000000000001",
            }),
        ).toEqual({
            action: "stop_managing",
            projectId: "00000000-0000-4000-8000-000000000001",
        });
        expect(
            parseProtocolTerminalOutcome("project_lifecycle.inspect", {
                status: "complete",
                value: {
                    schemaVersion: 1,
                    action: "stop_managing",
                    projectLifecycleReviewToken: "review",
                    projectId: "00000000-0000-4000-8000-000000000001",
                    projectAuthorityFingerprint: "a".repeat(64),
                    displayName: "Project",
                    rootPath: "/project",
                },
                diagnostics: [],
            }),
        ).toMatchObject({ status: "complete", value: { action: "stop_managing", rootPath: "/project" } });
        expect(() =>
            parseProtocolTerminalOutcome("project_lifecycle.inspect", {
                status: "complete",
                value: {
                    schemaVersion: 1,
                    action: "stop_managing",
                    projectLifecycleReviewToken: "review",
                    projectId: "00000000-0000-4000-8000-000000000001",
                    projectAuthorityFingerprint: "a".repeat(64),
                    displayName: "Project",
                    rootPath: "/project",
                    rootAccessState: "available",
                },
                diagnostics: [],
            }),
        ).toThrow(/unknown field/u);
        expect(
            parseProtocolTerminalOutcome("project_lifecycle.inspect", {
                status: "complete",
                value: {
                    schemaVersion: 1,
                    action: "restore",
                    projectLifecycleReviewToken: "review",
                    projectId: "00000000-0000-4000-8000-000000000001",
                    projectAuthorityFingerprint: "a".repeat(64),
                    displayName: "Project",
                    rootPath: "/missing",
                    rootAccessState: "unavailable",
                },
                diagnostics: [],
            }),
        ).toMatchObject({ status: "complete", value: { action: "restore", rootAccessState: "unavailable" } });
        expect(() =>
            parseProtocolTerminalOutcome("project_lifecycle.inspect", {
                status: "complete",
                value: {
                    schemaVersion: 1,
                    action: "restore",
                    projectLifecycleReviewToken: "review",
                    projectId: "00000000-0000-4000-8000-000000000001",
                    projectAuthorityFingerprint: "a".repeat(64),
                    displayName: "Project",
                    rootPath: "/missing",
                    rootAccessState: "unknown",
                },
                diagnostics: [],
            }),
        ).toThrow();
        expect(
            parseProtocolTerminalOutcome("project_lifecycle.inspect", {
                status: "complete",
                value: {
                    schemaVersion: 1,
                    action: "rebind",
                    projectLifecycleReviewToken: "review",
                    projectId: "00000000-0000-4000-8000-000000000001",
                    projectAuthorityFingerprint: "a".repeat(64),
                    displayName: "Project",
                    currentRootPath: "/old",
                    nextRootPath: "/new",
                },
                diagnostics: [],
            }),
        ).toMatchObject({ status: "complete", value: { action: "rebind", nextRootPath: "/new" } });
        expect(() =>
            parseProtocolTerminalOutcome("project_lifecycle.inspect", {
                status: "complete",
                value: {
                    schemaVersion: 1,
                    action: "rebind",
                    projectLifecycleReviewToken: "review",
                    projectId: "00000000-0000-4000-8000-000000000001",
                    projectAuthorityFingerprint: "a".repeat(64),
                    displayName: "Project",
                    currentRootPath: "/old",
                    nextRootPath: "/new",
                    nextDisplayName: "forbidden",
                },
                diagnostics: [],
            }),
        ).toThrow(/unknown field/u);
        expect(() =>
            parseProtocolTerminalOutcome("project_lifecycle.inspect", {
                status: "complete",
                value: {
                    ...VALID_TERMINAL_VALUES["project_lifecycle.inspect"],
                    projectAuthorityFingerprint: `sha256:${"a".repeat(64)}`,
                },
                diagnostics: [],
            }),
        ).toThrow();
        expect(() =>
            parseProtocolOperationParams("project_lifecycle.commit", {
                projectLifecycleReviewToken: "review",
                userActionId: "",
            }),
        ).toThrow();
    });

    it("models Global and Project Deployment subjects as strict wire branches", () => {
        const create = structuredClone(VALID_PARAMS["deployment.create"]);
        const global = { ...create, subject: { subjectKind: "global" as const } };
        expect(parseProtocolOperationParams("deployment.create", global)).toEqual(global);
        expect(
            parseProtocolOperationParams("deployment.list", {
                subject: { subjectKind: "global" },
                includeDeleted: true,
            }),
        ).toEqual({ subject: { subjectKind: "global" }, includeDeleted: true });
        expect(() =>
            parseProtocolOperationParams("deployment.create", {
                ...global,
                subject: { subjectKind: "global", projectId: "00000000-0000-4000-8000-000000000001" },
            }),
        ).toThrow(/unknown field/u);
        expect(() =>
            parseProtocolOperationParams("deployment.create", {
                ...create,
                subject: { subjectKind: "project" },
            }),
        ).toThrow(/missing required/u);
        expect(() =>
            parseProtocolOperationParams("deployment.list", {
                projectId: "00000000-0000-4000-8000-000000000001",
            }),
        ).toThrow(/unknown field/u);
    });

    it("enforces virgin authority emptiness and keeps raw filesystem paths out of Client requests", () => {
        expect(() =>
            parseProtocolOperationResult("adapter_enablement.get", {
                status: "complete",
                value: {
                    configVersion: 1,
                    settingId: "adapter_enablement_v1",
                    revision: 0,
                    enabledAdapterIds: ["claudecode"],
                    updatedAt: 0,
                    settingFingerprint: "a".repeat(64),
                },
                diagnostics: [],
            }),
        ).toThrow(/empty array/u);
        expect(() =>
            parseProtocolOperationResult("watched_scan_intent.get", {
                status: "complete",
                value: {
                    configVersion: 1,
                    settingId: "watched_scan_intent_v1",
                    revision: 0,
                    environments: [{}],
                    updatedAt: 0,
                    settingFingerprint: "a".repeat(64),
                },
                diagnostics: [],
            }),
        ).toThrow(/empty array/u);
        expect(() =>
            parseProtocolOperationParams("deployment.create", {
                projectId: "00000000-0000-4000-8000-000000000001",
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                targetRootPath: "/client/supplied/path",
                assets: [
                    {
                        assetId: "00000000-0000-4000-8000-000000000001",
                        versionId: "00000000-0000-4000-8000-000000000003",
                        allowIncomplete: false,
                    },
                ],
            }),
        ).toThrow(/unknown field|missing required/u);
    });

    it("keeps watched intent durable identity separate from transient probe rows and raw paths", () => {
        const configured = {
            configVersion: 1,
            settingId: "watched_scan_intent_v1",
            revision: 1,
            environments: [
                {
                    environment: { platform: "linux", platformInstanceId: "local-linux" },
                    sourceSelectors: [
                        {
                            disposition: "included",
                            source: {
                                adapterId: "claudecode",
                                rootRole: "source",
                                sourceDomain: "project_root",
                                canonicalPath: "/workspace/project/.claude",
                                locatorIdentities: [
                                    {
                                        locatorKind: "runtime_known_rule",
                                        locatorKey: "project_claude_directory",
                                    },
                                ],
                            },
                            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                            binding: {
                                assetScope: "project",
                                projectId: "00000000-0000-4000-8000-000000000001",
                            },
                            selectorFingerprint: "a".repeat(64),
                        },
                        {
                            disposition: "excluded",
                            source: {
                                adapterId: "claudecode",
                                rootRole: "unknown",
                                sourceDomain: "unknown",
                                canonicalPath: "/workspace/project/.claude-old",
                                locatorIdentities: [{ locatorKind: "unknown", locatorKey: "unclassified" }],
                            },
                            agentRuntimeIds: ["CLAUDE_CODE_APP"],
                            selectorFingerprint: "b".repeat(64),
                        },
                    ],
                },
            ],
            userActionEvidenceId: "user-action",
            updatedAt: 1,
            settingFingerprint: "c".repeat(64),
        };
        expect(
            parseProtocolOperationResult("watched_scan_intent.get", {
                status: "complete",
                value: configured,
                diagnostics: [],
            }),
        ).toEqual({ status: "complete", value: configured, diagnostics: [] });
        expect(() =>
            parseProtocolOperationResult("watched_scan_intent.get", {
                status: "complete",
                value: {
                    ...configured,
                    environments: [
                        {
                            environment: { platform: "linux", platformInstanceId: "local-linux" },
                            sourceSelectors: [
                                {
                                    disposition: "included",
                                    sourceRootId: "transient-root",
                                    agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                                    binding: { assetScope: "global" },
                                    selectorFingerprint: "a".repeat(64),
                                },
                            ],
                        },
                    ],
                },
                diagnostics: [],
            }),
        ).toThrow(/unknown field|missing required/u);
        expect(() =>
            parseProtocolOperationParams("watched_scan_intent.replace", {
                expectedRevision: 0,
                expectedSettingFingerprint: "a".repeat(64),
                decisions: [
                    {
                        action: "include_user_selected_root",
                        directoryRootPath: "/client/raw/path",
                        environment: { platform: "linux", platformInstanceId: "local-linux" },
                        adapterId: "claudecode",
                        agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        binding: { assetScope: "global" },
                    },
                ],
                userActionId: "user-action",
            }),
        ).toThrow(/unknown field|missing required/u);
    });

    it("requires strict source relationships and locator identities in fresh probe rows", () => {
        const value = structuredClone(VALID_TERMINAL_VALUES["adapter.probe"]);
        const result = value.results[0];
        const runtime = result?.runtimes[0];
        const source = result?.sources[0];
        expect(runtime?.sourceRootRowIds).toEqual(["source-row-1"]);
        expect(source?.locatorIdentities).toEqual([
            {
                locatorKind: "runtime_known_rule",
                locatorKey: "project_root",
            },
        ]);
        const locator = source?.locatorIdentities[0];
        if (result === undefined || runtime === undefined || source === undefined || locator === undefined) {
            throw new Error("probe fixture result, runtime, source and locator are required");
        }

        const { sourceRootRowIds: _omittedSourceRows, ...withoutSourceRows } = runtime;
        result.runtimes[0] = withoutSourceRows as typeof runtime;
        expect(() => parseProtocolTerminalOutcome("adapter.probe", { status: "complete", value, diagnostics: [] })).toThrow(
            /sourceRootRowIds.*missing required/u,
        );
        result.runtimes[0] = runtime;

        const { locatorIdentities: _omitted, ...withoutLocators } = source;
        result.sources[0] = withoutLocators as typeof source;
        expect(() => parseProtocolTerminalOutcome("adapter.probe", { status: "complete", value, diagnostics: [] })).toThrow(
            /locatorIdentities.*missing required/u,
        );

        result.sources[0] = { ...source, locatorIdentities: [] };
        expect(() => parseProtocolTerminalOutcome("adapter.probe", { status: "complete", value, diagnostics: [] })).toThrow(
            /locatorIdentities.*non-empty/u,
        );

        result.sources[0] = {
            ...source,
            locatorIdentities: [{ ...locator, evidenceLevel: "agent_runtime_verified" }],
        };
        expect(() => parseProtocolTerminalOutcome("adapter.probe", { status: "complete", value, diagnostics: [] })).toThrow(
            /evidenceLevel.*unknown field/u,
        );
    });

    it("projects strict callable binding requests instead of making Clients infer import dependencies", () => {
        const value = structuredClone(VALID_TERMINAL_VALUES["import.preview"]);
        const candidate = value.candidates[0];
        if (candidate === undefined) throw new Error("import preview fixture candidate is required");
        candidate.diagnosticCodes = ["antigravity.skill_trigger_frontmatter_unverified"];
        candidate.callableBindingRequests = [
            {
                subject: { subjectKind: "workflow_execution_agent" },
                rawTarget: "reviewer",
                required: true,
            },
            {
                subject: { subjectKind: "file_reference", logicalPath: "runbook.md", referenceIndex: 0 },
                rawTarget: "docs/review.md",
                required: false,
            },
            {
                subject: { subjectKind: "memory_catalog_member", memberIndex: 0 },
                rawTarget: "topics/review.md",
                required: true,
            },
        ];
        candidate.callableBindingRequestCount = 3;
        expect(parseProtocolTerminalOutcome("import.preview", { status: "complete", value, diagnostics: [] })).toEqual({
            status: "complete",
            value,
            diagnostics: [],
        });

        candidate.diagnosticCodes = [""];
        expect(() => parseProtocolTerminalOutcome("import.preview", { status: "complete", value, diagnostics: [] })).toThrow(
            /non-blank trimmed string/u,
        );
        candidate.diagnosticCodes = ["antigravity.skill_trigger_frontmatter_unverified"];

        candidate.callableBindingRequests = [
            {
                subject: { subjectKind: "workflow_execution_agent", targetCandidateId: "not-a-subject-field" },
                rawTarget: "reviewer",
                required: true,
            },
        ] as typeof candidate.callableBindingRequests;
        expect(() => parseProtocolTerminalOutcome("import.preview", { status: "complete", value, diagnostics: [] })).toThrow(
            /targetCandidateId.*unknown field/u,
        );

        candidate.callableBindingRequests = [
            {
                subject: { subjectKind: "memory_catalog_member", memberIndex: -1 },
                rawTarget: "topic.md",
                required: true,
            },
        ] as typeof candidate.callableBindingRequests;
        expect(() => parseProtocolTerminalOutcome("import.preview", { status: "complete", value, diagnostics: [] })).toThrow(
            /memberIndex/u,
        );
    });

    it("strictly parses complete, partial and failed long-operation terminal outcomes", () => {
        for (const name of PROTOCOL_ACCEPTED_LONG_NAMES) {
            expect(parseProtocolTerminalOutcome(name, completeTerminalValue(name))).toEqual(completeTerminalValue(name));
        }
        const value = VALID_TERMINAL_VALUES["asset.reindex"];
        expect(parseProtocolTerminalOutcome("asset.reindex", { status: "partial", value, diagnostics: [] })).toEqual({
            status: "partial",
            value,
            diagnostics: [],
        });
        expect(parseProtocolTerminalOutcome("asset.reindex", { status: "failed", diagnostics: [] })).toEqual({
            status: "failed",
            diagnostics: [],
        });
        expect(() => parseProtocolTerminalOutcome("asset.reindex", { status: "failed", value, diagnostics: [] })).toThrow();

        const notPrepared = { preparationState: "not_prepared" };
        expect(
            parseProtocolTerminalOutcome("reverse_accept.prepare", {
                status: "failed",
                value: notPrepared,
                diagnostics: [],
            }),
        ).toEqual({ status: "failed", value: notPrepared, diagnostics: [] });
        expect(parseProtocolTerminalOutcome("reverse_accept.prepare", { status: "failed", diagnostics: [] })).toEqual({
            status: "failed",
            diagnostics: [],
        });
        expect(() =>
            parseProtocolTerminalOutcome("reverse_accept.prepare", {
                status: "failed",
                value: { preparationState: "invented" },
                diagnostics: [],
            }),
        ).toThrow();
    });

    it("accepts every coherent Deployment freshness state and rejects each impossible relationship", () => {
        for (const freshness of [
            { state: "never", attemptedAt: 0, lastCompleteAt: 0 },
            { state: "in_progress", attemptedAt: 0, lastCompleteAt: 0 },
            { state: "complete", attemptedAt: 2, lastCompleteAt: 2 },
            { state: "partial", attemptedAt: 3, lastCompleteAt: 2 },
            { state: "failed", attemptedAt: 3, lastCompleteAt: 2 },
        ] as const) {
            expect(protocolDeploymentFreshnessSchema.parse(freshness)).toEqual(freshness);
        }
        expect(() => protocolDeploymentFreshnessSchema.parse({ state: "failed", attemptedAt: 1, lastCompleteAt: 2 })).toThrow(
            /cannot be newer than attemptedAt/u,
        );
        expect(() => protocolDeploymentFreshnessSchema.parse({ state: "never", attemptedAt: 1, lastCompleteAt: 0 })).toThrow(
            /never freshness must use zero timestamps/u,
        );
        expect(() => protocolDeploymentFreshnessSchema.parse({ state: "partial", attemptedAt: 0, lastCompleteAt: 0 })).toThrow(
            /terminal freshness requires an attempt time/u,
        );
        expect(() => protocolDeploymentFreshnessSchema.parse({ state: "complete", attemptedAt: 2, lastCompleteAt: 1 })).toThrow(
            /complete freshness timestamps must match/u,
        );
    });

    it("rejects undeclared Deployment action hints", () => {
        const base = structuredClone(VALID_RESULTS["deployment.get"]);
        const deployment = base.value;
        expect(() =>
            parseProtocolOperationResult("deployment.get", {
                ...base,
                value: { ...deployment, actionHints: ["repair_everything"] },
            }),
        ).toThrow(/actionHints/u);
    });

    it("keeps render degradation, approval, reverse, semantic, and path branches strict", () => {
        const value = structuredClone(VALID_TERMINAL_VALUES["deployment.render_analyze"]);
        expect(parseProtocolTerminalOutcome("deployment.render_analyze", { status: "complete", value, diagnostics: [] })).toEqual(
            {
                status: "complete",
                value,
                diagnostics: [],
            },
        );
        const option = value.options[0];
        const semantic = value.semantics[0];
        const outputUnit = value.outputUnits[0];
        const promotionAuthorization = value.promotionAuthorizationInspections[0];
        if (option === undefined || semantic === undefined || outputUnit === undefined || promotionAuthorization === undefined) {
            throw new Error("render analysis fixture requires one option, semantic, output unit, and promotion inspection");
        }
        for (const inspection of [
            promotionAuthorization,
            { ...promotionAuthorization, promotionAuthorizationState: "not_required" },
            {
                ...promotionAuthorization,
                promotionAuthorizationState: "authorized",
                authorizationSource: "version_target_grant",
                authorityId: UUID_C,
                authorityRevision: 2,
                authorityFingerprint: SHA_B,
            },
            {
                promotionAuthorizationState: "unavailable",
                assetId: promotionAuthorization.assetId,
                versionId: promotionAuthorization.versionId,
                target: promotionAuthorization.target,
                diagnosticCode: "render.promotion_authority_unavailable",
            },
        ]) {
            expect(
                parseProtocolTerminalOutcome("deployment.render_analyze", {
                    status: "complete",
                    value: { ...value, promotionAuthorizationInspections: [inspection] },
                    diagnostics: [],
                }),
            ).toMatchObject({ value: { promotionAuthorizationInspections: [inspection] } });
        }
        for (const inspection of [
            { ...promotionAuthorization, promotionAuthorizationState: "unknown" },
            { ...promotionAuthorization, target: { targetKind: "project", projectId: "not-a-uuid" } },
            { ...promotionAuthorization, authorityFingerprint: SHA_B },
            {
                ...promotionAuthorization,
                promotionAuthorizationState: "authorized",
                authorizationSource: "version_target_grant",
                authorityId: UUID_C,
                authorityRevision: 0,
                authorityFingerprint: SHA_B,
            },
            {
                promotionAuthorizationState: "unavailable",
                assetId: promotionAuthorization.assetId,
                versionId: promotionAuthorization.versionId,
                target: promotionAuthorization.target,
                diagnosticCode: "",
            },
        ]) {
            expect(() =>
                parseProtocolTerminalOutcome("deployment.render_analyze", {
                    status: "complete",
                    value: { ...value, promotionAuthorizationInspections: [inspection] },
                    diagnostics: [],
                }),
            ).toThrow();
        }
        const nativeGraph = { ...option, renderStrategy: "native_graph" };
        expect(
            parseProtocolTerminalOutcome("deployment.render_analyze", {
                status: "complete",
                value: { ...value, options: [nativeGraph] },
                diagnostics: [],
            }),
        ).toMatchObject({ value: { options: [{ renderStrategy: "native_graph" }] } });
        for (const invalidOption of [
            { ...option, outcome: "degraded" },
            { ...option, degradationKinds: ["runtime_specific_metadata_lost"] },
            { ...option, approvalState: "required" },
            { ...option, actualReverseExtractPolicy: "best_effort" },
            { ...option, requiredOutputUnitFingerprints: ["not-a-fingerprint"] },
            { ...option, renderStrategy: "native_tree" },
        ]) {
            expect(() =>
                parseProtocolTerminalOutcome("deployment.render_analyze", {
                    status: "complete",
                    value: { ...value, options: [invalidOption] },
                    diagnostics: [],
                }),
            ).toThrow();
        }
        expect(() =>
            parseProtocolTerminalOutcome("deployment.render_analyze", {
                status: "complete",
                value: { ...value, semantics: [{ ...semantic, semanticKind: "guidance.unknown" }] },
                diagnostics: [],
            }),
        ).toThrow(/semanticKind/u);
        expect(() =>
            parseProtocolTerminalOutcome("deployment.render_analyze", {
                status: "complete",
                value: { ...value, outputUnits: [{ ...outputUnit, targetRootPath: "/must-not-leak" }] },
                diagnostics: [],
            }),
        ).toThrow(/targetRootPath.*unknown field/u);
    });

    it("validates full progress and terminal events including observe-path proxy parsing", () => {
        const progress = {
            eventKind: "progress",
            operationId: "operation-1",
            sequence: 1,
            operation: "asset.reindex",
            progress: { stage: "indexing", completedUnits: 1, totalUnits: 2 },
        };
        const terminal = {
            eventKind: "terminal",
            operationId: "operation-1",
            sequence: 2,
            operation: "asset.reindex",
            outcome: completeTerminalValue("asset.reindex"),
        };
        expect(protocolOperationEventSchema.parse(progress)).toEqual(progress);
        expect(protocolOperationEventSchema.parse(terminal)).toEqual(terminal);
        expect(
            parseProtocolOperationResult("operation.observe", {
                status: "available",
                events: [progress, terminal],
            }),
        ).toEqual({ status: "available", events: [progress, terminal] });
        expect(
            parseProtocolOperationResult("operation.observe", {
                status: "operation_unavailable",
                events: [],
            }),
        ).toEqual({ status: "operation_unavailable", events: [] });
        expect(() =>
            parseProtocolOperationResult("operation.observe", {
                status: "operation_unavailable",
                events: [progress],
            }),
        ).toThrow(/empty array/u);
        expect(protocolEmptyArraySchema.parse([])).toEqual([]);
        expect(() => protocolEmptyArraySchema.parse([{}])).toThrow(/empty array/u);
        expect(() => protocolOperationEventSchema.parse({ ...progress, progress: { stage: "x" } })).toThrow();
        expect(() => protocolOperationEventSchema.parse({ ...terminal, outcome: { status: "complete" } })).toThrow();
    });

    it("reports every malformed runtime-registry shape", () => {
        const empty = protocolEmptyObjectSchema;
        const immediate: ProtocolOperationDefinition = {
            delivery: "immediate_query",
            paramsSchema: empty,
            resultSchema: empty,
        };
        const malformed: Record<string, ProtocolOperationDefinition> = {
            initialize: {
                ...immediate,
                terminalSchema: empty,
            },
            "adapter.probe": {
                delivery: "accepted_long",
                paramsSchema: empty,
                resultSchema: empty,
            },
            foreign: immediate,
            unknown: immediate,
        };
        const errors = validateProtocolOperationRegistry(malformed, [
            "initialize",
            "adapter.probe",
            "asset.get",
            "unknown",
            "unknown",
        ]);
        expect(errors).toEqual(
            expect.arrayContaining([
                "duplicate operation name unknown",
                "foreign registry operation foreign",
                "missing registry operation asset.get",
                "operation unknown has no delivery authority",
                "operation initialize must use control, received immediate_query",
                "non-long operation initialize declares long-operation schemas",
                "accepted-long operation adapter.probe has no terminal schema",
                "accepted-long operation adapter.probe has no progress schema",
            ]),
        );
        expect(() => assertProtocolOperationRegistry(malformed, ["initialize", "adapter.probe"])).toThrow(
            /invalid Protocol operation registry/u,
        );
    });

    it("keeps failed operation outcomes value-free", () => {
        const schema = protocolOperationOutcome(protocolString);
        expect(schema.parse({ status: "complete", value: "x", diagnostics: [] })).toEqual({
            status: "complete",
            value: "x",
            diagnostics: [],
        });
        expect(schema.parse({ status: "partial", value: "x", diagnostics: [] })).toEqual({
            status: "partial",
            value: "x",
            diagnostics: [],
        });
        expect(schema.parse({ status: "failed", diagnostics: [] })).toEqual({ status: "failed", diagnostics: [] });
        expect(() => schema.parse({ status: "failed", value: "x", diagnostics: [] })).toThrow(/unknown field/u);
    });
});
