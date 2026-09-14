import type {
    AdapterEnablementSettingV1,
    AdapterProviderSummary,
    AssetSummaryPage,
    AssetManifestV1,
    AssetVersionComparisonV1,
    AssetVersionBundle,
    AssetVersionFilePreview,
    AssetVersionFileTreePage,
    AssetVersionPage,
    AssetVersionTextPage,
    DeploymentRenderPreviewView,
    DeploymentRenderAnalysisView,
    DeploymentView,
    PromotionGrantV1,
    RestrictedSourcePromotionFullAccessSettingV1,
    Sha256Digest,
    UuidV4,
    WatchedScanIntentV1,
} from "@oaam/core";
import { describe, expect, it } from "vitest";
import { projectAsset, projectAssetVersion, projectDeployment, projectProject } from "../src/catalog-projection";
import {
    projectAssetSummaryPage,
    projectAssetVersionFilePreview,
    projectAssetVersionFileTreePage,
    projectAssetVersionComparison,
    projectAssetVersionPage,
    projectAssetVersionTextPage,
} from "../src/asset-library-projection";
import {
    hostCapacityFailure,
    hostInvocationFailure,
    projectCoreOutcome,
    projectCoreOutcomeWithFailedValue,
    projectDiagnostic,
    projectLookup,
    toCoreSha256,
    toProtocolSha256,
} from "../src/core-outcome";
import {
    projectDeploymentRenderPreview,
    projectReindex,
    projectRenderAnalysis,
    projectReverseCommit,
    toCoreRenderSelection,
} from "../src/render-projection";
import {
    projectAdapterEnablement,
    projectAdapterProvider,
    projectEnvironment,
    projectPromotionGrant,
    projectRestrictedSourceFullAccess,
    projectWatchedScanIntent,
    toCorePromotionTarget,
} from "../src/settings-projection";
import { ASSET_ID, PROJECT_ID, SHA, VERSION_ID } from "./support/host-test-fixtures";

const DIGEST = SHA as Sha256Digest;
const DIGEST_B = `sha256:${"b".repeat(64)}` as Sha256Digest;

function diagnostic() {
    return {
        severity: "warning" as const,
        code: "test.warning",
        message: "visible",
        path: "/visible",
        traceId: "trace",
        operation: "asset" as const,
        causeKind: "partial" as const,
        retryable: true,
        suggestedActions: ["retry" as const],
        rawSummary: "private",
    };
}

describe("Host Core-to-Protocol projections", () => {
    it("projects every bounded Asset-library page and preview branch", () => {
        const file = {
            fileId: PROJECT_ID,
            logicalPath: "guide.md",
            role: "entry",
            mediaType: "text/markdown",
            contentKind: "text",
            contentHash: DIGEST,
            byteSize: 7,
            executable: false,
            references: [],
        } as const;
        expect(
            projectAssetSummaryPage({
                status: "complete",
                value: { items: [], totalCount: 0, hasMore: false } satisfies AssetSummaryPage,
                diagnostics: [],
            }),
        ).toMatchObject({ value: { assets: [], hasMore: false } });
        expect(
            projectAssetVersionPage({
                status: "complete",
                value: {
                    found: true,
                    value: {
                        items: [
                            {
                                assetId: ASSET_ID,
                                versionId: VERSION_ID,
                                revision: 1,
                                status: "complete",
                                fingerprint: DIGEST,
                                originAuthorityFingerprint: DIGEST,
                                versionCanonicalContentFingerprint: DIGEST,
                                changeKind: "create",
                                sourceVersionId: "",
                                sourceDeploymentId: "",
                                changeNote: "",
                                fileCount: 1,
                                createdAt: 1,
                            },
                        ],
                        totalCount: 2,
                        hasMore: true,
                        nextCursor: "next-version",
                    } satisfies AssetVersionPage,
                },
                diagnostics: [],
            }),
        ).toMatchObject({ value: { found: true, value: { hasMore: true, nextCursor: "next-version" } } });
        expect(
            projectAssetVersionFileTreePage({
                status: "complete",
                value: {
                    found: true,
                    value: {
                        entries: [
                            {
                                entryKind: "directory",
                                relativeName: "references",
                                logicalPath: "references",
                                descendantFileCount: 1,
                            },
                            { entryKind: "file", relativeName: "guide.md", file },
                        ],
                        totalCount: 3,
                        hasMore: true,
                        nextCursor: "next-file",
                    } satisfies AssetVersionFileTreePage,
                },
                diagnostics: [],
            }),
        ).toMatchObject({
            value: {
                found: true,
                value: {
                    hasMore: true,
                    nextCursor: "next-file",
                    entries: [{ entryKind: "directory" }, { entryKind: "file", file: { byteLength: 7 } }],
                },
            },
        });
        for (const preview of [
            { previewKind: "text", file, text: "content", lineCount: 1 },
            { previewKind: "large_text", file, limitReason: "byte_limit" },
            { previewKind: "large_text", file, limitReason: "line_limit", observedLineCount: 5_001 },
        ] as const satisfies readonly AssetVersionFilePreview[]) {
            expect(
                projectAssetVersionFilePreview({
                    status: "complete",
                    value: { found: true, value: preview },
                    diagnostics: [],
                }),
            ).toMatchObject({ value: { found: true, value: { previewKind: preview.previewKind } } });
        }

        expect(
            projectAssetVersionTextPage({
                status: "complete",
                value: {
                    found: true,
                    value: {
                        file,
                        text: "content",
                        loadedByteStart: 0,
                        loadedByteEnd: 7,
                        totalBytes: 14,
                        firstLine: 1,
                        lastLine: 1,
                        totalLines: 2,
                        hasMore: true,
                        nextCursor: "next-text",
                    } satisfies AssetVersionTextPage,
                },
                diagnostics: [],
            }),
        ).toMatchObject({ value: { found: true, value: { hasMore: true, nextCursor: "next-text" } } });

        const comparison = {
            schemaVersion: 1,
            assetId: ASSET_ID,
            left: { versionId: VERSION_ID, versionFingerprint: DIGEST },
            right: { versionId: PROJECT_ID, versionFingerprint: DIGEST_B },
            files: [
                {
                    logicalPath: "guide.md",
                    changeKind: "added",
                    left: { state: "missing" },
                    right: { state: "present", file },
                },
            ],
            selectedFile: {
                comparisonKind: "text",
                logicalPath: "guide.md",
                left: { state: "present", file },
                right: { state: "missing" },
                algorithm: "myers",
                leftLineCount: 1,
                rightLineCount: 0,
                hunks: [],
            },
        } satisfies AssetVersionComparisonV1;
        expect(projectAssetVersionComparison({ status: "complete", value: comparison, diagnostics: [] })).toMatchObject({
            value: {
                files: [{ left: { state: "missing" }, right: { state: "present", file: { byteLength: 7 } } }],
                selectedFile: { left: { state: "present", file: { byteLength: 7 } }, right: { state: "missing" } },
            },
        });
    });

    it("projects missing, text, and binary states in an exact deployment preview", () => {
        const preview: DeploymentRenderPreviewView = {
            schemaVersion: 3,
            deploymentId: VERSION_ID as DeploymentRenderPreviewView["deploymentId"],
            renderInputFingerprint: DIGEST,
            selectionFingerprint: DIGEST,
            compilationFingerprint: DIGEST,
            previewFingerprint: DIGEST,
            replacementScope: { filePaths: ["created.md" as never], directoryPaths: [] },
            actionState: "ready_apply",
            files: [
                {
                    relativePath: "created.md" as never,
                    baselineState: "unmanaged",
                    changeKind: "create",
                    current: { state: "missing" },
                    desired: {
                        state: "present",
                        contentKind: "text",
                        contentHash: DIGEST,
                        byteSize: 7,
                        executable: false,
                        text: "created",
                    },
                },
                {
                    relativePath: "removed.bin" as never,
                    baselineState: "managed",
                    changeKind: "remove_managed",
                    current: {
                        state: "present",
                        contentKind: "binary",
                        contentHash: DIGEST_B,
                        byteSize: 2,
                        executable: true,
                    },
                    desired: { state: "missing" },
                },
            ],
            directories: [
                {
                    managedBoundaryRelativePath: ".claude/skills/demo" as never,
                    relativePath: ".claude/skills/demo/resources" as never,
                    baselineState: "managed",
                    changeKind: "remove_managed",
                    currentState: "present",
                    desiredState: "missing",
                },
            ],
        };
        expect(projectDeploymentRenderPreview("preview-token", preview)).toEqual({
            schemaVersion: 3,
            previewToken: "preview-token",
            deploymentId: VERSION_ID,
            renderInputFingerprint: "a".repeat(64),
            selectionFingerprint: "a".repeat(64),
            compilationFingerprint: "a".repeat(64),
            previewFingerprint: "a".repeat(64),
            replacementScope: { filePaths: ["created.md" as never], directoryPaths: [] },
            actionState: "ready_apply",
            files: [
                {
                    relativePath: "created.md",
                    baselineState: "unmanaged",
                    changeKind: "create",
                    current: { state: "missing" },
                    desired: {
                        state: "present",
                        contentKind: "text",
                        contentHash: "a".repeat(64),
                        byteSize: 7,
                        executable: false,
                        text: "created",
                    },
                },
                {
                    relativePath: "removed.bin",
                    baselineState: "managed",
                    changeKind: "remove_managed",
                    current: {
                        state: "present",
                        contentKind: "binary",
                        contentHash: "b".repeat(64),
                        byteSize: 2,
                        executable: true,
                    },
                    desired: { state: "missing" },
                },
            ],
            directories: [
                {
                    managedBoundaryRelativePath: ".claude/skills/demo",
                    relativePath: ".claude/skills/demo/resources",
                    baselineState: "managed",
                    changeKind: "remove_managed",
                    currentState: "present",
                    desiredState: "missing",
                },
            ],
        });
    });

    it("projects Core outcomes, diagnostics, lookups, fingerprints, and Host failures", () => {
        expect(toProtocolSha256(DIGEST)).toBe("a".repeat(64));
        expect(toCoreSha256("b".repeat(64))).toBe(`sha256:${"b".repeat(64)}`);
        expect(projectDiagnostic(diagnostic())).toEqual({
            severity: "warning",
            code: "test.warning",
            message: "visible",
            path: "/visible",
            traceId: "trace",
            operation: "asset",
            causeKind: "partial",
            retryable: true,
            suggestedActions: ["retry"],
        });
        expect(projectDiagnostic({ ...diagnostic(), path: "", traceId: "" })).not.toHaveProperty("path");
        expect(projectLookup({ found: true, value: 2 }, String)).toEqual({ found: true, value: "2" });
        expect(projectLookup({ found: false }, String)).toEqual({ found: false });
        expect(projectLookup({ found: true }, String)).toEqual({ found: false });
        expect(projectCoreOutcome({ status: "complete", value: 2, diagnostics: [] }, String)).toEqual({
            status: "complete",
            value: "2",
            diagnostics: [],
        });
        expect(projectCoreOutcome({ status: "partial", value: 2, diagnostics: [] }, String)).toEqual({
            status: "partial",
            value: "2",
            diagnostics: [],
        });
        expect(projectCoreOutcome({ status: "failed", value: 2, diagnostics: [diagnostic()] }, String)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "test.warning" }],
        });
        expect(
            projectCoreOutcomeWithFailedValue({ status: "failed", value: 2, diagnostics: [diagnostic()] }, String),
        ).toMatchObject({
            status: "failed",
            value: "2",
            diagnostics: [{ code: "test.warning" }],
        });
        expect(projectCoreOutcomeWithFailedValue({ status: "partial", value: 2, diagnostics: [] }, String)).toEqual({
            status: "partial",
            value: "2",
            diagnostics: [],
        });
        expect(hostInvocationFailure()).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.core_invocation_failed" }],
        });
        expect(hostCapacityFailure()).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.operation_capacity_exceeded", retryable: true }],
        });
    });

    it("projects catalog records without leaking canonical file bytes", () => {
        const project = {
            schemaVersion: 1,
            projectId: PROJECT_ID,
            rootPath: "/project",
            displayName: "Project",
            deleted: false,
            createdAt: 1,
            updatedAt: 2,
        } as Parameters<typeof projectProject>[0];
        expect(projectProject(project)).toEqual({
            projectId: PROJECT_ID,
            rootPath: "/project",
            displayName: "Project",
            deleted: false,
            createdAt: 1,
            updatedAt: 2,
        });

        const asset = {
            schemaVersion: 1,
            assetId: ASSET_ID,
            kind: "Guidance",
            scope: "global",
            projectId: "",
            scopePath: "",
            displayName: "Guidance",
            displayDescription: "",
            versionIds: [VERSION_ID],
            deleted: false,
            createdAt: 1,
            updatedAt: 2,
        } as AssetManifestV1;
        expect(projectAsset(asset)).not.toHaveProperty("projectId");
        expect(projectAsset({ ...asset, scope: "project", projectId: PROJECT_ID as UuidV4 })).toMatchObject({
            projectId: PROJECT_ID,
        });

        const bundle = {
            manifest: {
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                revision: 1,
                status: "complete",
                versionCanonicalContentFingerprint: DIGEST,
                files: [
                    {
                        fileId: PROJECT_ID,
                        logicalPath: "AGENTS.md",
                        role: "entry",
                        mediaType: "text/markdown",
                        contentKind: "text",
                        contentHash: DIGEST,
                        byteSize: 7,
                        executable: false,
                    },
                ],
                originAuthority: { originKind: "user_created" },
                createdAt: 3,
            },
            files: [{ text: "private bytes" }],
        } as unknown as AssetVersionBundle;
        expect(projectAssetVersion(bundle)).toEqual({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            revision: 1,
            status: "complete",
            versionCanonicalContentFingerprint: "a".repeat(64),
            files: [
                {
                    fileId: PROJECT_ID,
                    logicalPath: "AGENTS.md",
                    role: "entry",
                    mediaType: "text/markdown",
                    contentKind: "text",
                    contentHash: "a".repeat(64),
                    byteLength: 7,
                    executable: false,
                },
            ],
            createdAt: 3,
        });
        const deployment = {
            deploymentId: VERSION_ID,
            projectId: PROJECT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local-linux",
            targetRootPath: "/target",
            observationState: "complete",
            observationAttemptedAt: 5,
            lastCompleteObservationAt: 5,
            deleted: false,
            derivedStatus: { stage: "in_sync", reason: "ok", actionHints: ["check_now"] },
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
            createdAt: 4,
            updatedAt: 5,
        } as unknown as DeploymentView;
        expect(projectDeployment(deployment)).toMatchObject({
            deploymentId: VERSION_ID,
            actionHints: ["check_now"],
            freshness: { state: "complete", attemptedAt: 5, lastCompleteAt: 5 },
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            environment: { platform: "linux", platformInstanceId: "local-linux" },
            stage: "in_sync",
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
        });
    });

    it("projects Provider capability declarations and both settings states", () => {
        const provider = {
            adapterId: "CLAUDECODE",
            displayName: "Claude Code",
            version: "1",
            enabled: true,
            agentRuntimes: [{ agentRuntimeId: "CLAUDE_CODE_CLI", displayName: "CLI", entryClass: "cli" }],
            assetSourceCapabilities: [
                {
                    sourceCapabilityFingerprint: DIGEST,
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    assetKind: "Guidance",
                    entrySupportStatus: "supported",
                    rootLocatorKind: "runtime_known_rule",
                    rootRole: "source",
                    sourceDomain: "project_root",
                    sourcePathMechanism: "fixed_file",
                    evidenceLevel: "agent_runtime_verified",
                    readPolicy: "auto_read",
                    diagnostics: [diagnostic()],
                },
            ],
            assetTargetCapabilities: [
                {
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    assetKind: "Guidance",
                    entrySupportStatus: "supported",
                    renderStrategy: "native_file",
                    outputContractId: "output",
                    outputContractFingerprint: DIGEST,
                    targetContextSchemaId: "context",
                    targetContextSchemaFingerprint: DIGEST,
                    reverseExtractPolicy: "can_reconcile",
                    diagnostics: [],
                },
                {
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    assetKind: "Memory",
                    entrySupportStatus: "deferred",
                    diagnostics: [],
                },
            ],
            targetContextSchemas: [],
            materializerCapabilities: [],
            renderContractDeclarations: [],
        } as AdapterProviderSummary;
        expect(projectAdapterProvider(provider)).toMatchObject({
            adapterId: "CLAUDECODE",
            sourceCapabilities: [{ sourceCapabilityFingerprint: "a".repeat(64) }],
            targetCapabilities: [
                { entrySupportStatus: "supported", reverseExtractPolicy: "can_reconcile" },
                { entrySupportStatus: "deferred" },
            ],
        });

        const virgin = {
            configVersion: 1,
            settingId: "adapter_enablement_v1",
            revision: 0,
            enabledAdapterIds: [],
            updatedAt: 0,
            settingFingerprint: DIGEST,
        } as AdapterEnablementSettingV1;
        expect(projectAdapterEnablement(virgin)).toMatchObject({ revision: 0, enabledAdapterIds: [] });
        expect(
            projectAdapterEnablement({
                ...virgin,
                revision: 2,
                enabledAdapterIds: ["CLAUDECODE"],
                userActionEvidenceId: "user-action",
                updatedAt: 4,
            } as AdapterEnablementSettingV1),
        ).toMatchObject({ revision: 2, enabledAdapterIds: ["CLAUDECODE"], userActionEvidenceId: "user-action" });
    });

    it("projects durable watched intent and rejects impossible non-empty Protocol rows", () => {
        const virgin = {
            configVersion: 1,
            settingId: "watched_scan_intent_v1",
            revision: 0,
            environments: [],
            updatedAt: 0,
            settingFingerprint: DIGEST,
        } as WatchedScanIntentV1;
        expect(projectWatchedScanIntent(virgin)).toMatchObject({ revision: 0, environments: [] });

        const configured = {
            configVersion: 1,
            settingId: "watched_scan_intent_v1",
            revision: 1,
            environments: [
                {
                    environment: { platform: "linux", platformInstanceId: "local" },
                    sourceSelectors: [
                        {
                            disposition: "excluded",
                            source: {
                                adapterId: "CLAUDECODE",
                                rootRole: "source",
                                sourceDomain: "project_root",
                                canonicalPath: "/one",
                                locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "one" }],
                            },
                            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                            selectorFingerprint: DIGEST,
                        },
                        {
                            disposition: "included",
                            source: {
                                adapterId: "CLAUDECODE",
                                rootRole: "source",
                                sourceDomain: "project_root",
                                canonicalPath: "/two",
                                locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "two" }],
                            },
                            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                            binding: { assetScope: "project", projectId: PROJECT_ID },
                            selectorFingerprint: DIGEST,
                        },
                    ],
                },
            ],
            userActionEvidenceId: "user-action",
            updatedAt: 2,
            settingFingerprint: DIGEST,
        } as WatchedScanIntentV1;
        expect(projectWatchedScanIntent(configured)).toMatchObject({
            environments: [
                {
                    sourceSelectors: [
                        { disposition: "excluded", selectorFingerprint: "a".repeat(64) },
                        { disposition: "included", binding: { assetScope: "project", projectId: PROJECT_ID } },
                    ],
                },
            ],
        });

        const source = configured.environments[0]?.sourceSelectors[0];
        expect(() =>
            projectWatchedScanIntent({
                ...configured,
                environments: [{ ...configured.environments[0], sourceSelectors: [] }],
            } as WatchedScanIntentV1),
        ).toThrow(/source selectors/u);
        expect(() =>
            projectWatchedScanIntent({
                ...configured,
                environments: [
                    {
                        ...configured.environments[0],
                        sourceSelectors: [{ ...source, agentRuntimeIds: [] }],
                    },
                ],
            } as WatchedScanIntentV1),
        ).toThrow(/agent runtime ids/u);
        expect(() =>
            projectWatchedScanIntent({
                ...configured,
                environments: [
                    {
                        ...configured.environments[0],
                        sourceSelectors: [
                            {
                                ...source,
                                source: { ...source?.source, locatorIdentities: [] },
                            },
                        ],
                    },
                ],
            } as WatchedScanIntentV1),
        ).toThrow(/locator identities/u);
    });

    it("projects promotion targets, grants, full-access states, and environments", () => {
        expect(toCorePromotionTarget({ targetKind: "project", projectId: PROJECT_ID })).toEqual({
            targetKind: "project",
            projectId: PROJECT_ID,
        });
        expect(
            toCorePromotionTarget({
                targetKind: "global_target",
                targetAuthorityFingerprint: "a".repeat(64),
            }),
        ).toEqual({ targetKind: "global_target", targetAuthorityFingerprint: SHA });

        const projectGrant = {
            schemaVersion: 1,
            promotionGrantId: PROJECT_ID,
            subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
            target: { targetKind: "project", projectId: PROJECT_ID },
            grantState: "active",
            revision: 1,
            userActionEvidenceId: "user",
            updatedAt: 2,
            grantFingerprint: DIGEST,
        } as PromotionGrantV1;
        expect(projectPromotionGrant(projectGrant)).toMatchObject({
            target: { targetKind: "project", projectId: PROJECT_ID },
            grantFingerprint: "a".repeat(64),
        });
        expect(
            projectPromotionGrant({
                ...projectGrant,
                target: { targetKind: "global_target", targetAuthorityFingerprint: DIGEST },
            }),
        ).toMatchObject({ target: { targetKind: "global_target", targetAuthorityFingerprint: "a".repeat(64) } });

        const disabled = {
            configVersion: 1,
            settingId: "restricted_source_promotion_full_access_v1",
            state: "disabled",
            revision: 0,
            updatedAt: 0,
            settingFingerprint: DIGEST,
        } as RestrictedSourcePromotionFullAccessSettingV1;
        expect(projectRestrictedSourceFullAccess(disabled)).toMatchObject({ state: "disabled", revision: 0 });
        expect(
            projectRestrictedSourceFullAccess({
                ...disabled,
                state: "enabled",
                revision: 1,
                userActionEvidenceId: "user",
                enabledAt: 2,
            } as RestrictedSourcePromotionFullAccessSettingV1),
        ).toMatchObject({ state: "enabled", userActionEvidenceId: "user", enabledAt: 2 });
        expect(
            projectEnvironment({
                platform: "wsl",
                platformInstanceId: "ubuntu",
                accessRootPath: "/",
            }),
        ).toEqual({
            environment: { platform: "wsl", platformInstanceId: "ubuntu" },
            displayName: "wsl:ubuntu",
        });
    });

    it("maps render selections, analyses, reverse outcomes, and reindex reports", () => {
        expect(
            toCoreRenderSelection({
                schemaVersion: 1,
                renderInputFingerprint: "a".repeat(64),
                semanticOptions: [
                    { optionFingerprint: "b".repeat(64), approval: { action: "none" } },
                    {
                        optionFingerprint: "c".repeat(64),
                        approval: { action: "approve_once", userActionId: "user" },
                    },
                    {
                        optionFingerprint: "d".repeat(64),
                        approval: { action: "use_saved_policy", policyId: "policy" },
                    },
                ],
            }),
        ).toEqual({
            schemaVersion: 1,
            renderInputFingerprint: `sha256:${"a".repeat(64)}`,
            semanticOptions: [
                { optionFingerprint: `sha256:${"b".repeat(64)}`, approvalRequest: { approvalAction: "none" } },
                {
                    optionFingerprint: `sha256:${"c".repeat(64)}`,
                    approvalRequest: { approvalAction: "approve_once", userActionId: "user" },
                },
                {
                    optionFingerprint: `sha256:${"d".repeat(64)}`,
                    approvalRequest: { approvalAction: "use_saved_policy", policyId: "policy" },
                },
            ],
        });

        const analysis = {
            renderInputFingerprint: DIGEST,
            requiredSemantics: [
                {
                    semanticRefFingerprint: DIGEST,
                    consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
                    semanticKind: "guidance.content",
                    subject: { subjectKind: "file", assetId: ASSET_ID, versionId: VERSION_ID, fileId: PROJECT_ID },
                },
                {
                    semanticRefFingerprint: DIGEST_B,
                    consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
                    semanticKind: "memory.content",
                    subject: { subjectKind: "asset", assetId: ASSET_ID, versionId: VERSION_ID },
                },
            ],
            analyses: [
                {
                    outputUnits: [
                        {
                            outputUnitFingerprint: DIGEST,
                            claims: [{ relativePath: "CLAUDE.md", contentKind: "text", executable: false }],
                            managedDirectoryBoundaries: [{ relativePath: ".claude/skills", boundaryKind: "directory_inventory" }],
                        },
                    ],
                    semanticOptions: [
                        {
                            optionFingerprint: DIGEST,
                            semanticRefFingerprint: DIGEST,
                            renderStrategy: "native_file",
                            outcome: "preserved",
                            actualReverseExtractPolicy: "can_reconcile",
                            approvalRequirement: { approvalState: "not_required" },
                            requiredOutputUnitFingerprints: [DIGEST],
                            reasonCode: "native",
                            diagnostics: [],
                        },
                        {
                            optionFingerprint: DIGEST,
                            semanticRefFingerprint: DIGEST,
                            renderStrategy: "inline",
                            outcome: "degraded",
                            degradationKinds: ["runtime_specific_metadata_lost"],
                            degradationFingerprint: DIGEST,
                            actualReverseExtractPolicy: "unsupported",
                            approvalRequirement: {
                                approvalState: "required",
                                concerns: ["semantic_degradation", "reverse_extract_unsupported"],
                                approvalFingerprint: DIGEST,
                            },
                            requiredOutputUnitFingerprints: [],
                            reasonCode: "degraded",
                            diagnostics: [diagnostic()],
                        },
                    ],
                    blockedSemanticRefs: [
                        {
                            semanticRefFingerprint: DIGEST_B,
                            reasonCode: "memory_unsupported",
                            diagnostics: [diagnostic()],
                        },
                    ],
                    diagnostics: [diagnostic()],
                },
            ],
            promotionAuthorizationInspections: [
                {
                    promotionAuthorizationState: "authorized",
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    target: { targetKind: "project", projectId: PROJECT_ID },
                    versionOriginAuthorityFingerprint: DIGEST,
                    authorizationSource: "version_target_grant",
                    authorityId: PROJECT_ID,
                    authorityRevision: 2,
                    authorityFingerprint: DIGEST_B,
                },
            ],
        } as unknown as DeploymentRenderAnalysisView;
        expect(projectRenderAnalysis(VERSION_ID, analysis)).toMatchObject({
            deploymentId: VERSION_ID,
            renderInputFingerprint: "a".repeat(64),
            semantics: [
                {
                    semanticKind: "guidance.content",
                    consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
                    subject: { subjectKind: "file", assetId: ASSET_ID, versionId: VERSION_ID, fileId: PROJECT_ID },
                },
                {
                    semanticKind: "memory.content",
                    consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
                    subject: { subjectKind: "asset", assetId: ASSET_ID, versionId: VERSION_ID },
                },
            ],
            outputUnits: [
                {
                    claims: [{ relativePath: "CLAUDE.md" }],
                    managedDirectoryPaths: [".claude/skills"],
                },
            ],
            options: [
                {
                    approvalState: "not_required",
                    outcome: "preserved",
                    actualReverseExtractPolicy: "can_reconcile",
                },
                {
                    approvalState: "required",
                    approvalConcerns: ["semantic_degradation", "reverse_extract_unsupported"],
                    approvalFingerprint: "a".repeat(64),
                    outcome: "degraded",
                    degradationKinds: ["runtime_specific_metadata_lost"],
                    actualReverseExtractPolicy: "unsupported",
                },
            ],
            promotionAuthorizationInspections: [
                {
                    promotionAuthorizationState: "authorized",
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    target: { targetKind: "project", projectId: PROJECT_ID },
                    versionOriginAuthorityFingerprint: "a".repeat(64),
                    authorizationSource: "version_target_grant",
                    authorityId: PROJECT_ID,
                    authorityRevision: 2,
                    authorityFingerprint: "b".repeat(64),
                },
            ],
            blockedSemantics: [
                {
                    semanticRefFingerprint: "b".repeat(64),
                    reasonCode: "memory_unsupported",
                    diagnostics: [{ code: "test.warning" }],
                },
            ],
            diagnostics: [{ code: "test.warning" }],
        });
        expect(
            projectRenderAnalysis(VERSION_ID, {
                ...analysis,
                promotionAuthorizationInspections: [
                    {
                        promotionAuthorizationState: "required",
                        assetId: ASSET_ID,
                        versionId: VERSION_ID,
                        target: { targetKind: "global_target", targetAuthorityFingerprint: DIGEST_B },
                        versionOriginAuthorityFingerprint: DIGEST,
                    },
                    {
                        promotionAuthorizationState: "unavailable",
                        assetId: PROJECT_ID,
                        versionId: VERSION_ID,
                        target: { targetKind: "project", projectId: PROJECT_ID },
                        diagnosticCode: "render.promotion_authority_unavailable",
                    },
                ],
            }),
        ).toMatchObject({
            promotionAuthorizationInspections: [
                {
                    promotionAuthorizationState: "required",
                    target: { targetKind: "global_target", targetAuthorityFingerprint: "b".repeat(64) },
                    versionOriginAuthorityFingerprint: "a".repeat(64),
                },
                {
                    promotionAuthorizationState: "unavailable",
                    diagnosticCode: "render.promotion_authority_unavailable",
                },
            ],
        });
        const { promotionAuthorizationInspections: _inspections, ...sharedAnalysis } = analysis;
        expect(projectRenderAnalysis(VERSION_ID, sharedAnalysis)).toMatchObject({
            promotionAuthorizationInspections: [],
        });
        expect(projectReverseCommit({ commitState: "committed", version: { assetId: ASSET_ID, versionId: VERSION_ID } })).toEqual(
            {
                commitState: "committed",
                version: { assetId: ASSET_ID, versionId: VERSION_ID },
            },
        );
        expect(
            projectReverseCommit({
                commitState: "not_committed",
                versionPublicationState: "published_not_selected",
                version: { assetId: ASSET_ID, versionId: VERSION_ID },
            }),
        ).toMatchObject({ versionPublicationState: "published_not_selected", version: { versionId: VERSION_ID } });
        expect(projectReverseCommit({ commitState: "not_committed", versionPublicationState: "not_published" })).toEqual({
            commitState: "not_committed",
            versionPublicationState: "not_published",
        });
        expect(projectReverseCommit({ commitState: "outcome_unavailable" })).toEqual({ commitState: "outcome_unavailable" });
        expect(
            projectReindex({
                scannedAssets: 2,
                indexedAssets: 1,
                skippedAssets: 1,
                diagnostics: [diagnostic()],
            }),
        ).toMatchObject({ scannedAssets: 2, diagnostics: [{ code: "test.warning" }] });
    });
});
