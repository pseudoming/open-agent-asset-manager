import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi } from "@oaam/client-framework";
import { describe, expect, it, vi } from "vitest";
import { DesktopApplicationClient } from "../src/renderer/client/desktop-application-client";
import { DIGEST } from "./discovery-test-fixtures";

describe("Desktop application Client facade", () => {
    it("forwards finite catalog and operation methods without retaining transport listeners", async () => {
        const request = vi.fn(async () => ({ status: "complete", value: {}, diagnostics: [] })) as ClientConnectionApi["request"];
        const unsubscribeProgress = vi.fn();
        const start = vi.fn(async (operation: ProtocolOperationName) => ({
            operationId: `${operation}-id`,
            operation,
            terminal: Promise.resolve({ status: "failed", diagnostics: [] }),
            terminalSequence: null,
            subscribeProgress(listener: (progress: unknown, sequence: number) => void) {
                listener({ stage: "working", completedUnits: 1, totalUnits: 2 }, 3);
                return unsubscribeProgress;
            },
        })) as ClientConnectionApi["start"];
        const unsubscribeInvalidation = vi.fn();
        const subscribeInvalidation = vi.fn(() => unsubscribeInvalidation);
        const client = new DesktopApplicationClient({ request, start, subscribeInvalidation } as unknown as ClientConnectionApi, [
            "project.list",
            "deployment.deploy",
        ]);
        const updates: unknown[] = [];
        const longListener = (update: unknown) => updates.push(update);

        await client.listProjects();
        await client.getProject({ projectId: "11111111-1111-4111-8111-111111111111" });
        await client.registerProject({ localPathSelectionToken: "token" });
        await client.inspectProjectLifecycle(
            {
                action: "rename",
                projectId: "11111111-1111-4111-8111-111111111111",
                nextDisplayName: "Renamed",
            },
            longListener,
        );
        await client.commitProjectLifecycle(
            {
                projectLifecycleReviewToken: "project-lifecycle-review",
                userActionId: "action",
            },
            longListener,
        );
        await client.listAssets();
        await client.searchCatalog({ query: "guide", limitPerGroup: 8 });
        await client.getAsset({ assetId: "11111111-1111-4111-8111-111111111111" });
        await client.getAssetVersion({
            assetId: "11111111-1111-4111-8111-111111111111",
            versionId: "22222222-2222-4222-8222-222222222222",
        });
        await client.listAssetKindCounts({ subject: { scope: "global" }, keywords: "" });
        await client.queryAssetLibrary({
            subject: { scope: "project", projectId: "11111111-1111-4111-8111-111111111111" },
            keywords: "guide",
            kind: "Guidance",
            pageSize: 50,
        });
        await client.listAssetVersions({
            assetId: "11111111-1111-4111-8111-111111111111",
            pageSize: 50,
        });
        await client.listAssetVersionFileChildren({
            assetId: "11111111-1111-4111-8111-111111111111",
            versionId: "22222222-2222-4222-8222-222222222222",
            directoryPath: "",
            pageSize: 50,
        });
        await client.readAssetVersionFilePreview({
            assetId: "11111111-1111-4111-8111-111111111111",
            versionId: "22222222-2222-4222-8222-222222222222",
            logicalPath: "AGENTS.md",
        });
        await client.readAssetVersionTextPage({
            assetId: "11111111-1111-4111-8111-111111111111",
            versionId: "22222222-2222-4222-8222-222222222222",
            logicalPath: "AGENTS.md",
        });
        await client.compareAssetVersions(
            {
                assetId: "11111111-1111-4111-8111-111111111111",
                left: { versionId: "22222222-2222-4222-8222-222222222222", versionFingerprint: DIGEST },
                right: { versionId: "33333333-3333-4333-8333-333333333333", versionFingerprint: DIGEST },
                logicalPath: "AGENTS.md",
            },
            longListener,
        );
        await client.exportAssetVersion(
            {
                source: {
                    assetId: "11111111-1111-4111-8111-111111111111",
                    versionId: "22222222-2222-4222-8222-222222222222",
                    versionFingerprint: DIGEST,
                    originAuthorityFingerprint: DIGEST,
                },
                localPathSelectionToken: "export-path",
                userActionId: "action",
            },
            longListener,
        );
        await client.exportAssetVersionNative(
            {
                source: {
                    assetId: "11111111-1111-4111-8111-111111111111",
                    versionId: "22222222-2222-4222-8222-222222222222",
                    versionFingerprint: DIGEST,
                    originAuthorityFingerprint: DIGEST,
                },
                localPathSelectionToken: "native-export-path",
                userActionId: "native-action",
            },
            longListener,
        );
        await client.updateAssetDisplay({
            assetId: "11111111-1111-4111-8111-111111111111",
            displayName: "Renamed",
            displayDescription: "Updated",
        });
        await client.copyAsset({
            source: {
                assetId: "11111111-1111-4111-8111-111111111111",
                versionId: "22222222-2222-4222-8222-222222222222",
                versionFingerprint: DIGEST,
                originAuthorityFingerprint: DIGEST,
            },
            destination: { scope: "global", scopePath: "" },
            displayName: "Copy",
            displayDescription: "",
            userActionId: "action",
        });
        await client.softDeleteAsset({ assetId: "11111111-1111-4111-8111-111111111111" });
        await client.restoreAsset({ assetId: "11111111-1111-4111-8111-111111111111" });
        await client.inspectAssetPurge({ assetId: "11111111-1111-4111-8111-111111111111" });
        await client.commitAssetPurge(
            {
                preparation: {
                    schemaVersion: 1,
                    assetId: "11111111-1111-4111-8111-111111111111",
                    assetManifestFingerprint: DIGEST,
                    assetDirectoryIdentityFingerprint: DIGEST,
                    versionCount: 1,
                    promotionGrantCount: 0,
                    deploymentRelations: [],
                    inboundDependencies: [],
                    canPurge: true,
                    blockingReasons: [],
                },
                userActionId: "action",
            },
            longListener,
        );
        await client.cancelOperation({ operationId: "operation-1" });
        await client.listDeployments();
        await client.getDeployment({ deploymentId: "33333333-3333-4333-8333-333333333333" });
        await client.createDeployment({
            probeToken: "probe",
            probeResultRowId: "result",
            targetRowId: "target",
            projectId: "11111111-1111-4111-8111-111111111111",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [
                {
                    assetId: "11111111-1111-4111-8111-111111111111",
                    versionId: "22222222-2222-4222-8222-222222222222",
                    allowIncomplete: false,
                },
            ],
        });
        await client.updateDeploymentInputs({
            deploymentId: "33333333-3333-4333-8333-333333333333",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        });
        await client.listPromotionGrants({ assetId: "11111111-1111-4111-8111-111111111111" });
        await client.createPromotionGrant({
            promotionAction: "grant_current_version_current_target",
            assetId: "11111111-1111-4111-8111-111111111111",
            versionId: "22222222-2222-4222-8222-222222222222",
            target: { targetKind: "project", projectId: "11111111-1111-4111-8111-111111111111" },
            userActionId: "action",
        });
        await client.revokePromotionGrant({
            promotionGrantId: "44444444-4444-4444-8444-444444444444",
            expectedRevision: 1,
            expectedGrantFingerprint: DIGEST,
            userActionId: "action",
        });
        await client.getRestrictedSourceFullAccess();
        await client.setRestrictedSourceFullAccess({
            expectedRevision: 0,
            expectedSettingFingerprint: DIGEST,
            nextState: "enabled",
            userActionId: "action",
        });
        await client.analyzeAssetUsage(
            {
                probeToken: "probe",
                probeResultRowId: "result",
                targetRowId: "target",
                subject: { subjectKind: "project", projectId: "11111111-1111-4111-8111-111111111111" },
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                asset: {
                    assetId: "11111111-1111-4111-8111-111111111111",
                    versionId: "22222222-2222-4222-8222-222222222222",
                    allowIncomplete: false,
                },
            },
            longListener,
        );
        await client.analyzeDeployment({ deploymentId: "33333333-3333-4333-8333-333333333333" }, longListener);
        await client.previewDeployment(
            {
                deploymentId: "33333333-3333-4333-8333-333333333333",
                selection: { schemaVersion: 1, renderInputFingerprint: DIGEST, semanticOptions: [] },
            },
            longListener,
        );
        await client.deploy(
            {
                deploymentId: "33333333-3333-4333-8333-333333333333",
                selection: { schemaVersion: 1, renderInputFingerprint: DIGEST, semanticOptions: [] },
                deploymentAction: "apply",
            },
            longListener,
        );
        await client.scanDeployment({ deploymentId: "33333333-3333-4333-8333-333333333333" }, longListener);
        await client.inspectRenderedTarget({ deploymentId: "33333333-3333-4333-8333-333333333333" }, longListener);
        await client.getRenderedInspectionDetail({ inspectionToken: "inspection", selector: "detail" });
        await client.repairDeployment(
            {
                deploymentId: "33333333-3333-4333-8333-333333333333",
                inspectionToken: "inspection",
                expectedInspectionResultFingerprint: DIGEST,
                userActionId: "action",
            },
            longListener,
        );
        await client.recoverDeployment({ deploymentId: "33333333-3333-4333-8333-333333333333" }, longListener);
        await client.prepareReverseAccept(
            {
                deploymentId: "33333333-3333-4333-8333-333333333333",
                inspectionToken: "inspection",
                inspectionResultFingerprint: DIGEST,
            },
            longListener,
        );
        await client.commitReverseAccept(
            {
                preparationId: "55555555-5555-4555-8555-555555555555",
                expectedPreparationRevision: 1,
                userActionId: "action",
                newVersionPromotion: "use_existing_authority",
                renderSelection: { schemaVersion: 1, renderInputFingerprint: DIGEST, semanticOptions: [] },
            },
            longListener,
        );
        await client.cancelReverseAccept(
            { preparationId: "55555555-5555-4555-8555-555555555555", expectedPreparationRevision: 1 },
            longListener,
        );
        await client.reindexAssets({ assetIds: ["11111111-1111-4111-8111-111111111111"] }, longListener);
        await client.listStateBackups();
        await client.getStateBackupPromptPolicy();
        await client.replaceStateBackupPromptPolicy({
            expectedRevision: 0,
            expectedSettingFingerprint: DIGEST,
            mode: "back_up_first",
            userActionId: "action",
        });
        await client.getDiagnosticsHealth();
        await client.getOrdinaryLogSettings();
        await client.replaceOrdinaryLogSettings({
            enabled: true,
            retentionDays: 14,
            maximumBytes: 50 * 1024 * 1024,
        });
        await client.clearOrdinaryLog({ confirmedPermanentRemoval: true });
        await client.inspectSupportBundle({ mode: "standard" }, longListener);
        await client.exportSupportBundle(
            {
                supportBundleReviewToken: "support-review",
                localPathSelectionToken: "support-export-path",
                userActionId: "action",
            },
            longListener,
        );
        await client.inspectStateBackup(
            { destination: { destinationKind: "oaam_default" }, encryptionMode: "none" },
            longListener,
        );
        await client.createStateBackup({ backupReviewToken: "backup-review", userActionId: "action" }, longListener);
        await client.inspectStateRestore(
            {
                source: {
                    sourceKind: "inventory_backup",
                    backupId: "66666666-6666-4666-8666-666666666666",
                },
            },
            longListener,
        );
        await client.activateStateRestore({ restoreReviewToken: "restore-review", userActionId: "action" }, longListener);
        const invalidationListener = vi.fn();
        expect(client.subscribeInvalidation(invalidationListener)).toBe(unsubscribeInvalidation);

        expect(request.mock.calls.map(([method]) => method)).toEqual([
            "project.list",
            "project.get",
            "project.register",
            "asset.list",
            "catalog.search",
            "asset.get",
            "asset_version.get",
            "asset_library.kind_counts",
            "asset_library.page",
            "asset_version.list",
            "asset_version.file_children",
            "asset_version.file_preview",
            "asset_version.text_page",
            "asset.display.update",
            "asset.copy",
            "asset.soft_delete",
            "asset.restore",
            "asset.purge.inspect",
            "operation.cancel",
            "deployment.list",
            "deployment.get",
            "deployment.create",
            "deployment.update_inputs",
            "promotion_grant.list",
            "promotion_grant.create",
            "promotion_grant.revoke",
            "restricted_source_full_access.get",
            "restricted_source_full_access.set",
            "rendered_inspection.detail",
            "state_backup.list",
            "state_backup_prompt_policy.get",
            "state_backup_prompt_policy.replace",
            "diagnostics.health.get",
            "diagnostics.ordinary_log.settings.get",
            "diagnostics.ordinary_log.settings.replace",
            "diagnostics.ordinary_log.clear",
        ]);
        expect(start.mock.calls.map(([method]) => method)).toEqual([
            "project_lifecycle.inspect",
            "project_lifecycle.commit",
            "asset_version.compare",
            "asset_version.export",
            "asset_version.export_native",
            "asset.purge.commit",
            "asset_usage.analyze",
            "deployment.render_analyze",
            "deployment.render_preview",
            "deployment.deploy",
            "deployment.scan",
            "deployment.inspect_rendered_target",
            "deployment.repair",
            "deployment.recover",
            "reverse_accept.prepare",
            "reverse_accept.commit",
            "reverse_accept.cancel",
            "asset.reindex",
            "diagnostics.support_bundle.inspect",
            "diagnostics.support_bundle.export",
            "state_backup.inspect",
            "state_backup.create",
            "state_restore.inspect",
            "state_restore.activate",
        ]);
        expect(updates).toHaveLength(48);
        expect(updates[0]).toMatchObject({ status: "accepted", operationId: "project_lifecycle.inspect-id" });
        expect(updates[1]).toMatchObject({ status: "progress", sequence: 3, progress: { stage: "working" } });
        expect(unsubscribeProgress).toHaveBeenCalledTimes(24);
        expect(subscribeInvalidation).toHaveBeenCalledWith(invalidationListener);
        expect(client.availableOperations).toEqual(["project.list", "deployment.deploy"]);
        expect(client.supportsOperation("project.list")).toBe(true);
        expect(client.supportsOperation("asset.list")).toBe(false);
    });
});
