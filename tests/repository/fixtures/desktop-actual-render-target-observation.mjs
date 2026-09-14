import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

export function observeMissingProjectGuidanceTarget(repositoryRoot = process.cwd()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-actual-render-target-observation-"));
    try {
        const { observeAssetUsageTarget } = require(
            path.join(repositoryRoot, "packages/core/dist/orchestration/asset-usage-target-observation.js"),
        );
        const digest = `sha256:${"a".repeat(64)}`;
        const result = observeAssetUsageTarget({
            materialization: {
                schemaVersion: 1,
                renderInputFingerprint: digest,
                selectionFingerprint: digest,
                units: [
                    {
                        outputUnit: {
                            outputUnitFingerprint: digest,
                            outputContractId: "ACTUAL_RENDER_PROJECT_GUIDANCE",
                            outputContractFingerprint: digest,
                            claims: [{ relativePath: "CLAUDE.md", contentKind: "text", executable: false }],
                            managedDirectoryBoundaries: [],
                        },
                        renderer: {
                            outputUnitFingerprint: digest,
                            rendererAdapterId: "ACTUAL_RENDER",
                            rendererAdapterVersion: "1.0.0",
                            materializerCapabilityKey: "actual-render-project-guidance",
                            materializationProfileId: "actual-render-project-guidance",
                            profileConstraintFingerprint: digest,
                        },
                        providerRenderDialectInputFingerprint: digest,
                        materializationFingerprint: digest,
                        semanticCoverageProof: {
                            outputUnitFingerprint: digest,
                            coveredSemanticRefFingerprints: [digest],
                            coverageFingerprint: digest,
                        },
                        files: [
                            {
                                relativePath: "CLAUDE.md",
                                content: { contentKind: "text", text: "# Project guidance\n\nUse OAAM safely.\n" },
                                executable: false,
                                semanticRefFingerprints: [digest],
                                sectionBindings: [],
                            },
                        ],
                    },
                ],
            },
            targetRootPath: root,
            platformContext: { platform: process.platform, platformInstanceId: "actual-render", accessRootPath: root },
        });
        if (result.observedTargetState !== "absent") {
            throw new Error(`actual-render target observation was ${String(result.observedTargetState)}, expected absent`);
        }
        return result.observedTargetState;
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
