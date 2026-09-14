import { createProtocolRequest } from "@oaam/app-server-protocol";
import type { ExportAssetVersionNativeFilesToFileResultV1 } from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import { dispatchH1Long } from "../src/dispatch-registry";
import { HostPathSelectionStore } from "../src/path-selection-store";
import { ASSET_ID, DIGEST, VERSION_ID, complete, fakeCoreWith } from "./support/host-test-fixtures";

describe("H1 native Asset export dispatch", () => {
    it("consumes only its exact one-shot path authority and fails closed without one", async () => {
        const nativeExportResult: ExportAssetVersionNativeFilesToFileResultV1 = {
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            versionFingerprint: DIGEST,
            dialectId: "claude-guidance-v1",
            representationFingerprint: DIGEST,
            fileCount: 1,
            archiveByteLength: 2_048,
        };
        const exportAssetVersionNativeFilesToFile = vi.fn(async () => complete(nativeExportResult));
        const core = fakeCoreWith({ exportAssetVersionNativeFilesToFile });
        const pathSelections = new HostPathSelectionStore({ createToken: () => "native-export-token" });
        const token = pathSelections.register("asset_native_export_file", "/tmp/guidance-original.zip");

        const exported = await dispatchH1Long(
            core,
            createProtocolRequest("native-export", "asset_version.export_native", {
                source: {
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    versionFingerprint: "a".repeat(64),
                    originAuthorityFingerprint: "b".repeat(64),
                },
                localPathSelectionToken: token,
                userActionId: "native-export-review",
            }),
            undefined,
            pathSelections,
        );
        expect(exported).toEqual({
            status: "complete",
            value: {
                ...nativeExportResult,
                versionFingerprint: "a".repeat(64),
                representationFingerprint: "a".repeat(64),
            },
            diagnostics: [],
        });
        expect(exportAssetVersionNativeFilesToFile).toHaveBeenCalledWith({
            source: {
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                versionFingerprint: DIGEST,
                originAuthorityFingerprint: `sha256:${"b".repeat(64)}`,
            },
            destinationPath: "/tmp/guidance-original.zip",
            userActionEvidenceId: "native-export-review",
        });

        const unavailable = await dispatchH1Long(
            core,
            createProtocolRequest("native-export-missing", "asset_version.export_native", {
                source: {
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    versionFingerprint: "a".repeat(64),
                    originAuthorityFingerprint: "b".repeat(64),
                },
                localPathSelectionToken: "missing-native-export-token",
                userActionId: "missing-native-export-review",
            }),
        );
        expect(unavailable).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.path_selection_unavailable" }],
        });
        expect(exportAssetVersionNativeFilesToFile).toHaveBeenCalledTimes(1);
    });
});
