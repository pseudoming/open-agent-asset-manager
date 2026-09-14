import type { ProtocolAcceptedLongOperationName, ProtocolOperationName } from "../../src";
import * as nativeExportFixtures from "./asset-native-export-fixtures";
import { ASSET_USAGE_ANALYZE_PARAMS, ASSET_USAGE_TERMINAL_VALUE } from "./asset-usage-fixtures";
import { CATALOG_SEARCH_RESULT } from "./catalog-search-fixtures";
import { SHA_A, SHA_B, UUID_A, UUID_B, UUID_C } from "./protocol-fixture-primitives";
import { RENDER_ANALYSIS } from "./render-fixtures";
import {
    STATE_BACKUP_ARTIFACT,
    STATE_BACKUP_INVENTORY,
    STATE_BACKUP_PROMPT_POLICY,
    STATE_BACKUP_REVIEW,
    STATE_RESTORE_ACTIVATION,
    STATE_RESTORE_REVIEW,
} from "./state-resilience-fixtures";
import { SUPPORT_BUNDLE_ARTIFACT, SUPPORT_BUNDLE_REVIEW } from "./support-bundle-fixtures";

export { CATALOG_SEARCH_RESULT } from "./catalog-search-fixtures";
export { DIAGNOSTIC } from "./diagnostic-fixture";
export { SHA_A, SHA_B, UUID_A, UUID_B, UUID_C } from "./protocol-fixture-primitives";
export {
    STATE_BACKUP_ARTIFACT,
    STATE_BACKUP_INVENTORY,
    STATE_BACKUP_PROMPT_POLICY,
    STATE_BACKUP_REVIEW,
    STATE_RESTORE_ACTIVATION,
    STATE_RESTORE_REVIEW,
} from "./state-resilience-fixtures";

export const ENVIRONMENT = Object.freeze({
    platform: "linux",
    platformInstanceId: "local-linux",
});

export const PROJECT = Object.freeze({
    projectId: UUID_A,
    displayName: "Project",
    rootPath: "/workspace/project",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
});

export const PROJECT_LIFECYCLE_REVIEW = Object.freeze({
    schemaVersion: 1,
    action: "rename",
    projectLifecycleReviewToken: "project-lifecycle-review-token",
    projectId: UUID_A,
    projectAuthorityFingerprint: SHA_A,
    rootPath: "/workspace/project",
    currentDisplayName: "Project",
    nextDisplayName: "Renamed Project",
});

export const ADAPTER_ENABLEMENT = Object.freeze({
    configVersion: 1,
    settingId: "adapter_enablement_v1",
    revision: 0,
    enabledAdapterIds: [],
    updatedAt: 0,
    settingFingerprint: SHA_A,
});

export const WATCHED_SCAN_INTENT = Object.freeze({
    configVersion: 1,
    settingId: "watched_scan_intent_v1",
    revision: 0,
    environments: [],
    updatedAt: 0,
    settingFingerprint: SHA_A,
});

export const ASSET_SUMMARY = Object.freeze({
    assetId: UUID_A,
    kind: "Guidance",
    scope: "project",
    projectId: UUID_B,
    scopePath: "",
    displayName: "Guidance",
    displayDescription: "",
    currentVersionId: UUID_C,
    currentRevision: 1,
    currentFingerprint: SHA_A,
    currentVersionStatus: "complete",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
});

export const ASSET = Object.freeze({
    assetId: UUID_A,
    kind: "Guidance",
    scope: "project",
    projectId: UUID_B,
    scopePath: "",
    displayName: "Guidance",
    displayDescription: "",
    versionIds: [UUID_C],
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
});

export const VERSION = Object.freeze({
    assetId: UUID_A,
    versionId: UUID_C,
    revision: 1,
    status: "complete",
    versionCanonicalContentFingerprint: SHA_A,
    files: [
        {
            fileId: UUID_B,
            logicalPath: "AGENTS.md",
            role: "entry",
            mediaType: "text/markdown",
            contentKind: "text",
            contentHash: SHA_B,
            byteLength: 12,
            executable: false,
        },
    ],
    importSource: {
        adapterId: "ANTIGRAVITY",
        sourceSnapshotFingerprint: SHA_A,
        roots: [
            {
                sourceRootId: "source-root-1",
                rootRole: "project_actual",
                sourceDomain: "project_root",
                canonicalPath: "/workspace/demo-plugin",
            },
        ],
        files: [{ sourceRootId: "source-root-1", relativePath: "AGENTS.md", contentHash: SHA_B }],
    },
    createdAt: 2,
});

export const ASSET_PURGE_PREPARATION = Object.freeze({
    schemaVersion: 1,
    action: "purge",
    assetId: UUID_A,
    assetManifestFingerprint: SHA_A,
    assetDirectoryIdentityFingerprint: SHA_B,
    kind: "Guidance",
    scope: "project",
    projectId: UUID_B,
    scopePath: "",
    displayName: "Guidance",
    versionCount: 1,
    promotionGrantCount: 0,
});

export const DEPLOYMENT_ASSET = Object.freeze({
    assetId: UUID_A,
    versionId: UUID_C,
    allowIncomplete: false,
});

export const DEPLOYMENT = Object.freeze({
    deploymentId: UUID_B,
    subject: { subjectKind: "project", projectId: UUID_A },
    consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
    environment: ENVIRONMENT,
    targetRootPath: "/workspace/project",
    stage: "in_sync",
    reason: "in_sync",
    actionHints: ["check_now"],
    freshness: { state: "complete", attemptedAt: 2, lastCompleteAt: 2 },
    deleted: false,
    assets: [DEPLOYMENT_ASSET],
    createdAt: 1,
    updatedAt: 2,
});

export const PROMOTION_TARGET = Object.freeze({ targetKind: "project", projectId: UUID_A });
export const PROMOTION_GRANT = Object.freeze({
    promotionGrantId: UUID_C,
    subject: {
        subjectKind: "asset_version",
        assetId: UUID_A,
        versionId: UUID_B,
    },
    target: PROMOTION_TARGET,
    grantState: "active",
    revision: 1,
    updatedAt: 2,
    grantFingerprint: SHA_A,
});

export const FULL_ACCESS = Object.freeze({
    configVersion: 1,
    settingId: "restricted_source_promotion_full_access_v1",
    state: "disabled",
    revision: 0,
    updatedAt: 0,
    settingFingerprint: SHA_A,
});

export const RENDER_SELECTION = Object.freeze({
    schemaVersion: 1,
    renderInputFingerprint: SHA_A,
    semanticOptions: [
        {
            optionFingerprint: SHA_B,
            approval: { action: "approve_once", userActionId: "user-action" },
        },
    ],
});

export const RENDER_PREVIEW = Object.freeze({
    schemaVersion: 3,
    previewToken: "render-preview-token",
    deploymentId: UUID_B,
    renderInputFingerprint: SHA_A,
    selectionFingerprint: SHA_B,
    compilationFingerprint: SHA_A,
    previewFingerprint: SHA_B,
    replacementScope: { filePaths: ["CLAUDE.md"], directoryPaths: [] },
    actionState: "ready_apply",
    files: [
        {
            relativePath: "CLAUDE.md",
            baselineState: "unmanaged",
            changeKind: "create",
            current: { state: "missing" },
            desired: {
                state: "present",
                contentKind: "text",
                contentHash: SHA_A,
                byteSize: 10,
                executable: false,
                text: "# Guidance",
            },
        },
    ],
    directories: [],
});

function complete(value: unknown): unknown {
    return { status: "complete", value, diagnostics: [] };
}

export const VALID_PARAMS: Readonly<Record<ProtocolOperationName, unknown>> = Object.freeze({
    "environment.list": { platforms: ["linux"] },
    "adapter_provider.list": {},
    "adapter_enablement.get": {},
    "watched_scan_intent.get": {},
    "probe_environment_reference.list": { probeToken: "probe-token" },
    "project.list": {},
    "project.get": { projectId: UUID_A },
    "catalog.search": { query: "Project", limitPerGroup: 8 },
    "asset.list": {},
    "asset.get": { assetId: UUID_A },
    "asset_version.get": { assetId: UUID_A, versionId: UUID_C },
    "asset_library.kind_counts": { subject: { scope: "global" }, keywords: "" },
    "asset_library.page": {
        subject: { scope: "project", projectId: UUID_B },
        keywords: "Guidance",
        kind: "Guidance",
        pageSize: 50,
    },
    "asset_version.list": { assetId: UUID_A, pageSize: 25 },
    "asset_version.file_children": {
        assetId: UUID_A,
        versionId: UUID_C,
        directoryPath: "",
        pageSize: 50,
    },
    "asset_version.file_preview": {
        assetId: UUID_A,
        versionId: UUID_C,
        logicalPath: "AGENTS.md",
    },
    "asset_version.text_page": {
        assetId: UUID_A,
        versionId: UUID_C,
        logicalPath: "AGENTS.md",
    },
    "asset_version.compare": {
        assetId: UUID_A,
        left: { versionId: UUID_C, versionFingerprint: SHA_B },
        right: { versionId: UUID_B, versionFingerprint: SHA_A },
        logicalPath: "AGENTS.md",
    },
    "asset_version.export": {
        source: {
            assetId: UUID_A,
            versionId: UUID_C,
            versionFingerprint: SHA_B,
            originAuthorityFingerprint: SHA_A,
        },
        localPathSelectionToken: "export-path-token",
        userActionId: "user-action",
    },
    "asset_version.export_native": nativeExportFixtures.ASSET_NATIVE_EXPORT_PARAMS,
    "asset.purge.inspect": { assetId: UUID_A },
    "deployment.list": {},
    "deployment.get": { deploymentId: UUID_B },
    "promotion_grant.list": { assetId: UUID_A },
    "restricted_source_full_access.get": {},
    "state_backup.list": {},
    "state_backup_prompt_policy.get": {},
    "diagnostics.health.get": {},
    "diagnostics.ordinary_log.settings.get": {},
    "import_preview.detail": { previewToken: "preview-token", candidateId: "candidate-1" },
    "rendered_inspection.detail": { inspectionToken: "inspection-token", selector: "file-1" },
    "adapter_enablement.replace": {
        expectedRevision: 0,
        expectedSettingFingerprint: SHA_A,
        enabledAdapterIds: ["claudecode"],
        userActionId: "user-action",
    },
    "watched_scan_intent.replace": {
        expectedRevision: 0,
        expectedSettingFingerprint: SHA_A,
        decisions: [
            {
                action: "retain_existing",
                selectorFingerprint: SHA_B,
            },
            {
                action: "include_observed",
                probeToken: "probe-token",
                probeResultRowId: "probe-result-1",
                sourceRootRowId: "source-row-1",
                agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                binding: { assetScope: "project", projectId: UUID_A },
            },
            {
                action: "exclude_observed",
                probeToken: "probe-token",
                probeResultRowId: "probe-result-1",
                sourceRootRowId: "source-row-2",
                agentRuntimeIds: ["CLAUDE_CODE_APP"],
            },
            {
                action: "include_user_selected_root",
                localPathSelectionToken: "path-token",
                environment: ENVIRONMENT,
                adapterId: "claudecode",
                agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                binding: { assetScope: "global" },
            },
        ],
        userActionId: "user-action",
    },
    "diagnostics.ordinary_log.settings.replace": {
        enabled: true,
        retentionDays: 14,
        maximumBytes: 52_428_800,
    },
    "diagnostics.ordinary_log.clear": {
        confirmedPermanentRemoval: true,
    },
    "watched_scan_intent.reset": {
        expectedRevision: 0,
        expectedSettingFingerprint: SHA_A,
        userActionId: "user-action",
    },
    "project.register": { localPathSelectionToken: "path-token" },
    "asset.display.update": {
        assetId: UUID_A,
        displayName: "Renamed Guidance",
        displayDescription: "Updated display metadata",
    },
    "asset.copy": {
        source: {
            assetId: UUID_A,
            versionId: UUID_C,
            versionFingerprint: SHA_B,
            originAuthorityFingerprint: SHA_A,
        },
        destination: { scope: "global", scopePath: "" },
        displayName: "Guidance copy",
        displayDescription: "",
        userActionId: "user-action",
    },
    "asset.soft_delete": { assetId: UUID_A },
    "asset.restore": { assetId: UUID_A },
    "deployment.create": {
        probeToken: "probe-token",
        probeResultRowId: "probe-result-1",
        targetRowId: "target-row-1",
        subject: { subjectKind: "project", projectId: UUID_A },
        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        assets: [DEPLOYMENT_ASSET],
    },
    "asset_usage.analyze": ASSET_USAGE_ANALYZE_PARAMS,
    "deployment.update_inputs": {
        deploymentId: UUID_B,
        assets: [DEPLOYMENT_ASSET],
    },
    "deployment.soft_delete": { deploymentId: UUID_B },
    "promotion_grant.create": {
        promotionAction: "grant_current_version_current_target",
        assetId: UUID_A,
        versionId: UUID_B,
        target: PROMOTION_TARGET,
        userActionId: "user-action",
    },
    "promotion_grant.revoke": {
        promotionGrantId: UUID_C,
        expectedRevision: 1,
        expectedGrantFingerprint: SHA_A,
        userActionId: "user-action",
    },
    "restricted_source_full_access.set": {
        expectedRevision: 0,
        expectedSettingFingerprint: SHA_A,
        nextState: "enabled",
        userActionId: "user-action",
    },
    "state_backup_prompt_policy.replace": {
        expectedRevision: 0,
        expectedSettingFingerprint: SHA_A,
        mode: "back_up_first",
        userActionId: "user-action",
    },
    "import_preview.cancel": { previewToken: "preview-token" },
    "adapter.probe": {
        adapterIds: ["claudecode"],
        environments: [ENVIRONMENT],
        authorization: { scope: "global" },
    },
    "adapter.read": {
        probeToken: "probe-token",
        selections: [{ probeResultRowId: "probe-result-1", sourceRootRowIds: ["source-row-1"] }],
    },
    "import.preview": { readToken: "read-token" },
    "import.accept_batch": {
        previewToken: "preview-token",
        expectedSnapshotFingerprint: SHA_A,
        decisions: [
            {
                candidateId: "candidate-1",
                freshness: { freshnessAction: "require_current_source" },
                promotion: { promotionAction: "import_only", userActionId: "user-action" },
                callableBindings: [],
                action: "create_asset",
            },
        ],
    },
    "project_lifecycle.inspect": {
        action: "rename",
        projectId: UUID_A,
        nextDisplayName: "Renamed Project",
    },
    "project_lifecycle.commit": {
        projectLifecycleReviewToken: "project-lifecycle-review-token",
        userActionId: "rename-project",
    },
    "asset.purge.commit": {
        preparation: ASSET_PURGE_PREPARATION,
        userActionId: "user-action",
    },
    "deployment.render_analyze": { deploymentId: UUID_B },
    "deployment.render_preview": { deploymentId: UUID_B, selection: RENDER_SELECTION },
    "deployment.deploy": {
        previewToken: "render-preview-token",
        deploymentAction: "apply",
    },
    "deployment.scan": { deploymentId: UUID_B },
    "deployment.inspect_rendered_target": { deploymentId: UUID_B },
    "deployment.repair": {
        deploymentId: UUID_B,
        inspectionToken: "inspection-token",
        expectedInspectionResultFingerprint: SHA_A,
        userActionId: "user-action",
    },
    "deployment.recover": { deploymentId: UUID_B },
    "reverse_accept.prepare": {
        deploymentId: UUID_B,
        inspectionToken: "inspection-token",
        inspectionResultFingerprint: SHA_A,
    },
    "reverse_accept.commit": {
        preparationId: UUID_A,
        expectedPreparationRevision: 1,
        userActionId: "user-action",
        newVersionPromotion: "use_existing_authority",
        renderSelection: RENDER_SELECTION,
    },
    "reverse_accept.cancel": { preparationId: UUID_A, expectedPreparationRevision: 1 },
    "asset.reindex": {},
    "state_backup.inspect": {
        destination: { destinationKind: "oaam_default" },
        encryptionMode: "none",
    },
    "state_backup.create": {
        backupReviewToken: "backup-review-token",
        userActionId: "user-action",
    },
    "state_restore.inspect": {
        source: { sourceKind: "inventory_backup", backupId: UUID_A },
    },
    "state_restore.activate": {
        restoreReviewToken: "restore-review-token",
        userActionId: "user-action",
    },
    "diagnostics.support_bundle.inspect": {
        mode: "standard",
    },
    "diagnostics.support_bundle.export": {
        supportBundleReviewToken: "support-review-token",
        localPathSelectionToken: "support-export-token",
        userActionId: "user-action",
    },
    initialize: { protocolVersion: 1, clientKind: "headless", clientVersion: "0.1.0" },
    "operation.observe": { operationId: "operation-1", afterSequence: 0 },
    "operation.cancel": { operationId: "operation-1" },
});

export const VALID_RESULTS: Readonly<Record<ProtocolOperationName, unknown>> = Object.freeze({
    "environment.list": complete({ environments: [{ environment: ENVIRONMENT, displayName: "Local Linux" }] }),
    "adapter_provider.list": complete({
        providers: [
            {
                adapterId: "claudecode",
                displayName: "Claude Code",
                version: "1.0.0",
                enabled: false,
                agentRuntimes: [{ agentRuntimeId: "CLAUDE_CODE_CLI", displayName: "Claude Code CLI", entryClass: "cli" }],
                sourceCapabilities: [
                    {
                        sourceCapabilityFingerprint: SHA_A,
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        assetKind: "Guidance",
                        entrySupportStatus: "supported",
                        rootLocatorKind: "runtime_known_rule",
                        rootRole: "source",
                        sourceDomain: "project_root",
                        sourcePathMechanism: "fixed_file",
                        evidenceLevel: "agent_runtime_verified",
                        readPolicy: "auto_read",
                        diagnostics: [],
                    },
                ],
                targetCapabilities: [
                    {
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        assetKind: "Guidance",
                        entrySupportStatus: "supported",
                        renderStrategy: "native_file",
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
            },
        ],
    }),
    "adapter_enablement.get": complete(ADAPTER_ENABLEMENT),
    "watched_scan_intent.get": complete(WATCHED_SCAN_INTENT),
    "probe_environment_reference.list": complete({
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
    }),
    "project.list": complete({ projects: [PROJECT] }),
    "project.get": complete({ found: true, value: PROJECT }),
    "catalog.search": complete(CATALOG_SEARCH_RESULT),
    "asset.list": complete({ assets: [ASSET_SUMMARY] }),
    "asset.get": complete({ found: true, value: ASSET }),
    "asset_version.get": complete({ found: true, value: VERSION }),
    "asset_library.kind_counts": complete({
        counts: [
            { kind: "Guidance", count: 1 },
            { kind: "Rule", count: 0 },
            { kind: "Workflow", count: 0 },
            { kind: "Skill", count: 0 },
            { kind: "Subagent", count: 0 },
            { kind: "Memory", count: 0 },
        ],
    }),
    "asset_library.page": complete({
        assets: [ASSET_SUMMARY],
        totalCount: 1,
        hasMore: false,
    }),
    "asset_version.list": complete({
        found: true,
        value: {
            versions: [
                {
                    assetId: UUID_A,
                    versionId: UUID_C,
                    revision: 1,
                    status: "complete",
                    fingerprint: SHA_B,
                    originAuthorityFingerprint: SHA_A,
                    versionCanonicalContentFingerprint: SHA_A,
                    changeKind: "create",
                    sourceVersionId: "",
                    sourceDeploymentId: "",
                    changeNote: "",
                    fileCount: 1,
                    createdAt: 2,
                },
            ],
            totalCount: 1,
            hasMore: false,
        },
    }),
    "asset_version.file_children": complete({
        found: true,
        value: {
            entries: [
                {
                    entryKind: "file",
                    relativeName: "AGENTS.md",
                    file: VERSION.files[0],
                },
            ],
            totalCount: 1,
            hasMore: false,
        },
    }),
    "asset_version.file_preview": complete({
        found: true,
        value: {
            previewKind: "text",
            file: VERSION.files[0],
            text: "# Guidance\n",
            lineCount: 2,
        },
    }),
    "asset_version.text_page": complete({
        found: true,
        value: {
            file: VERSION.files[0],
            text: "# Guidance\n",
            loadedByteStart: 0,
            loadedByteEnd: 11,
            totalBytes: 11,
            firstLine: 1,
            lastLine: 2,
            totalLines: 2,
            hasMore: false,
        },
    }),
    "asset.purge.inspect": complete(ASSET_PURGE_PREPARATION),
    "deployment.list": complete({ deployments: [DEPLOYMENT] }),
    "deployment.get": complete({ found: true, value: DEPLOYMENT }),
    "promotion_grant.list": complete({ grants: [{ ...PROMOTION_GRANT, targetDescription: { status: "unavailable" } }] }),
    "restricted_source_full_access.get": complete(FULL_ACCESS),
    "state_backup.list": complete(STATE_BACKUP_INVENTORY),
    "state_backup_prompt_policy.get": complete(STATE_BACKUP_PROMPT_POLICY),
    "diagnostics.health.get": complete({
        schemaVersion: 1,
        overallStatus: "healthy",
        host: { lifecycleState: "ready", startupMode: "normal" },
        ordinaryLog: {
            state: "active",
            suspensionReason: "none",
            retainedBytes: 512,
            maximumBytes: 52_428_800,
            segmentCount: 1,
        },
    }),
    "diagnostics.ordinary_log.settings.get": complete({
        schemaVersion: 1,
        enabled: true,
        retentionDays: 14,
        maximumBytes: 52_428_800,
    }),
    "import_preview.detail": complete({
        candidateId: "candidate-1",
        mediaType: "text/markdown",
        contentKind: "text",
        text: { text: "# Guidance", byteLength: 10, truncated: false },
        byteLength: 10,
        contentHash: SHA_A,
    }),
    "rendered_inspection.detail": complete({
        inspectionToken: "inspection-token",
        selector: "file-1",
        detailKind: "semantic_change",
        changeKind: "file_content_replacement",
        changeFingerprint: SHA_A,
        content: {
            contentKind: "text",
            mediaType: "text/plain",
            text: { text: "changed", byteLength: 7, truncated: false },
            contentHash: SHA_B,
        },
    }),
    "adapter_enablement.replace": complete(ADAPTER_ENABLEMENT),
    "watched_scan_intent.replace": complete(WATCHED_SCAN_INTENT),
    "diagnostics.ordinary_log.settings.replace": complete({
        schemaVersion: 1,
        enabled: true,
        retentionDays: 14,
        maximumBytes: 52_428_800,
    }),
    "diagnostics.ordinary_log.clear": complete({
        removedSegmentCount: 1,
        removedBytes: 512,
        settings: {
            schemaVersion: 1,
            enabled: true,
            retentionDays: 14,
            maximumBytes: 52_428_800,
        },
    }),
    "watched_scan_intent.reset": complete(WATCHED_SCAN_INTENT),
    "project.register": complete(PROJECT),
    "asset.display.update": complete({ ...ASSET, displayName: "Renamed Guidance" }),
    "asset.copy": complete({
        source: { assetId: UUID_A, versionId: UUID_C },
        asset: {
            assetId: UUID_B,
            kind: ASSET.kind,
            scope: "global",
            scopePath: "",
            displayName: "Guidance copy",
            displayDescription: "",
            versionIds: ASSET.versionIds,
            deleted: false,
            createdAt: ASSET.createdAt,
            updatedAt: ASSET.updatedAt,
        },
        version: { ...VERSION, assetId: UUID_B },
    }),
    "asset.soft_delete": complete({ ...ASSET, deleted: true }),
    "asset.restore": complete(ASSET),
    "deployment.create": complete(DEPLOYMENT),
    "deployment.update_inputs": complete(DEPLOYMENT),
    "deployment.soft_delete": complete(DEPLOYMENT),
    "promotion_grant.create": complete(PROMOTION_GRANT),
    "promotion_grant.revoke": complete(PROMOTION_GRANT),
    "restricted_source_full_access.set": complete(FULL_ACCESS),
    "state_backup_prompt_policy.replace": complete({
        ...STATE_BACKUP_PROMPT_POLICY,
        revision: 1,
        mode: "back_up_first",
        userActionEvidenceId: "user-action",
        updatedAt: 10,
    }),
    "import_preview.cancel": complete({ cancelled: true }),
    "adapter.probe": { operationId: "operation-1" },
    "adapter.read": { operationId: "operation-1" },
    "import.preview": { operationId: "operation-1" },
    "import.accept_batch": { operationId: "operation-1" },
    "project_lifecycle.inspect": { operationId: "operation-1" },
    "project_lifecycle.commit": { operationId: "operation-1" },
    "asset_version.compare": { operationId: "operation-1" },
    "asset_version.export": { operationId: "operation-1" },
    "asset_version.export_native": nativeExportFixtures.ASSET_NATIVE_EXPORT_RESULT,
    "asset.purge.commit": { operationId: "operation-1" },
    "asset_usage.analyze": { operationId: "operation-1" },
    "deployment.render_analyze": { operationId: "operation-1" },
    "deployment.render_preview": { operationId: "operation-1" },
    "deployment.deploy": { operationId: "operation-1" },
    "deployment.scan": { operationId: "operation-1" },
    "deployment.inspect_rendered_target": { operationId: "operation-1" },
    "deployment.repair": { operationId: "operation-1" },
    "deployment.recover": { operationId: "operation-1" },
    "reverse_accept.prepare": { operationId: "operation-1" },
    "reverse_accept.commit": { operationId: "operation-1" },
    "reverse_accept.cancel": { operationId: "operation-1" },
    "asset.reindex": { operationId: "operation-1" },
    "state_backup.inspect": { operationId: "operation-1" },
    "state_backup.create": { operationId: "operation-1" },
    "state_restore.inspect": { operationId: "operation-1" },
    "state_restore.activate": { operationId: "operation-1" },
    "diagnostics.support_bundle.inspect": { operationId: "operation-1" },
    "diagnostics.support_bundle.export": { operationId: "operation-1" },
    initialize: {
        protocolVersion: 1,
        hostInstanceId: "host-1",
        availableOperations: ["initialize", "asset.list"],
    },
    "operation.observe": { status: "available", events: [] },
    "operation.cancel": { status: "requested" },
});

export const VALID_TERMINAL_VALUES: Readonly<Record<ProtocolAcceptedLongOperationName, unknown>> = Object.freeze({
    "adapter.probe": {
        probeToken: "probe-token",
        results: [
            {
                rowId: "probe-result-1",
                adapterId: "claudecode",
                environment: ENVIRONMENT,
                status: "complete",
                runtimes: [
                    {
                        rowId: "runtime-row-1",
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        versionText: "2.1.19",
                        installationStatus: "available",
                        projectDiscoveryStatus: "complete",
                        sourceRootRowIds: ["source-row-1"],
                        diagnostics: [],
                    },
                ],
                sources: [
                    {
                        rowId: "source-row-1",
                        sourceRootId: "source-root-1",
                        rootRole: "project_actual",
                        sourceDomain: "project_root",
                        displayPath: "/workspace/project",
                        accessStatus: "available",
                        locatorIdentities: [
                            {
                                locatorKind: "runtime_known_rule",
                                locatorKey: "project_root",
                            },
                        ],
                        diagnostics: [],
                    },
                ],
                projects: [
                    {
                        rowId: "project-row-1",
                        observedProjectId: "observed-project-1",
                        displayName: "Project",
                        workspaceSourceRowIds: ["source-row-1"],
                        containedSourceRootRowIds: ["source-row-1"],
                        diagnostics: [],
                    },
                ],
                targets: [
                    {
                        rowId: "target-row-1",
                        targetCandidateId: "target-candidate-1",
                        targetKind: "project",
                        displayName: "Project",
                        displayPath: "/workspace/project",
                        entryApplicabilities: [
                            {
                                agentRuntimeId: "CLAUDE_CODE_CLI",
                                status: "ready_for_plan",
                                diagnostics: [],
                            },
                        ],
                        diagnostics: [],
                    },
                ],
                diagnostics: [],
            },
        ],
    },
    "adapter.read": {
        readToken: "read-token",
        reports: [
            {
                adapterId: "claudecode",
                agentRuntimeId: "CLAUDE_CODE_CLI",
                sourceRootId: "root-1",
                status: "complete",
                candidateCount: 1,
                diagnostics: [],
            },
        ],
        candidateCount: 1,
    },
    "import.preview": {
        previewToken: "preview-token",
        snapshotFingerprint: SHA_A,
        candidates: [
            {
                candidateId: "candidate-1",
                kind: "Guidance",
                scope: "project",
                displayName: "Guidance",
                displayDescription: "",
                status: "importable",
                freshness: "fresh",
                fileCount: 1,
                logicalPaths: ["entry.md"],
                logicalPathsTruncated: false,
                callableBindingRequestCount: 0,
                callableBindingRequests: [],
                callableBindingRequestsTruncated: false,
            },
        ],
    },
    "import.accept_batch": {
        schemaVersion: 1,
        items: [
            { status: "complete", candidateId: "candidate-1", version: { assetId: UUID_A, versionId: UUID_B }, diagnostics: [] },
        ],
    },
    "project_lifecycle.inspect": PROJECT_LIFECYCLE_REVIEW,
    "project_lifecycle.commit": {
        ...PROJECT,
        displayName: "Renamed Project",
        updatedAt: 3,
    },
    "asset_version.compare": {
        schemaVersion: 1,
        assetId: UUID_A,
        left: { versionId: UUID_C, versionFingerprint: SHA_B },
        right: { versionId: UUID_B, versionFingerprint: SHA_A },
        files: [
            {
                logicalPath: "AGENTS.md",
                changeKind: "modified",
                left: { state: "present", file: VERSION.files[0] },
                right: { state: "present", file: { ...VERSION.files[0], contentHash: SHA_B } },
            },
        ],
        selectedFile: {
            comparisonKind: "text",
            logicalPath: "AGENTS.md",
            left: { state: "present", file: VERSION.files[0] },
            right: { state: "present", file: { ...VERSION.files[0], contentHash: SHA_B } },
            algorithm: "myers",
            leftLineCount: 2,
            rightLineCount: 2,
            hunks: [
                {
                    leftStart: 1,
                    leftLineCount: 2,
                    rightStart: 1,
                    rightLineCount: 2,
                    lines: [
                        { lineKind: "remove", text: "# Old", leftLine: 1 },
                        { lineKind: "add", text: "# Guidance", rightLine: 1 },
                        { lineKind: "context", text: "", leftLine: 2, rightLine: 2 },
                    ],
                },
            ],
        },
    },
    "asset_version.export": {
        assetId: UUID_A,
        versionId: UUID_C,
        versionFingerprint: SHA_B,
        archiveIndexFingerprint: SHA_A,
        archiveByteLength: 1_024,
    },
    "asset_version.export_native": nativeExportFixtures.ASSET_NATIVE_EXPORT_TERMINAL_VALUE,
    "asset.purge.commit": {
        assetId: UUID_A,
        recycled: true,
    },
    "asset_usage.analyze": ASSET_USAGE_TERMINAL_VALUE,
    "deployment.render_analyze": RENDER_ANALYSIS,
    "deployment.render_preview": RENDER_PREVIEW,
    "deployment.deploy": DEPLOYMENT,
    "deployment.scan": DEPLOYMENT,
    "deployment.inspect_rendered_target": {
        inspectionToken: "inspection-token",
        deploymentId: UUID_B,
        inspectionResultFingerprint: SHA_A,
        changeCount: 1,
        conflictCount: 0,
        details: [{ selector: "file-1", detailKind: "semantic_change", displayName: "entry.md" }],
        detailsTruncated: false,
    },
    "deployment.repair": DEPLOYMENT,
    "deployment.recover": DEPLOYMENT,
    "reverse_accept.prepare": {
        preparationState: "prepared",
        preparationId: UUID_A,
        preparationRevision: 1,
        expiresAt: 2,
        promotionState: "already_authorized",
        renderAnalysis: RENDER_ANALYSIS,
    },
    "reverse_accept.commit": { commitState: "committed", version: { assetId: UUID_A, versionId: UUID_B } },
    "reverse_accept.cancel": {},
    "asset.reindex": { scannedAssets: 1, indexedAssets: 1, skippedAssets: 0, diagnostics: [] },
    "state_backup.inspect": STATE_BACKUP_REVIEW,
    "state_backup.create": STATE_BACKUP_ARTIFACT,
    "state_restore.inspect": STATE_RESTORE_REVIEW,
    "state_restore.activate": STATE_RESTORE_ACTIVATION,
    "diagnostics.support_bundle.inspect": SUPPORT_BUNDLE_REVIEW,
    "diagnostics.support_bundle.export": SUPPORT_BUNDLE_ARTIFACT,
});

export function completeTerminalValue(name: ProtocolAcceptedLongOperationName): unknown {
    return { status: "complete", value: VALID_TERMINAL_VALUES[name], diagnostics: [] };
}
