import type {
    AssetManifestV1,
    AssetVersionBundle,
    AssetVersionManifestV2,
    DeploymentView,
    ImportProvenanceAuthority,
    ProjectLifecyclePreparationV1,
    ProjectManifestV1,
} from "@oaam/core";
import { toProtocolSha256 } from "./core-outcome";

export function projectProject(project: ProjectManifestV1) {
    return {
        projectId: project.projectId,
        displayName: project.displayName,
        rootPath: project.rootPath,
        deleted: project.deleted,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
    };
}

export function projectProjectLifecycleReview(projectLifecycleReviewToken: string, preparation: ProjectLifecyclePreparationV1) {
    return {
        ...preparation,
        projectLifecycleReviewToken,
        projectAuthorityFingerprint: toProtocolSha256(preparation.projectAuthorityFingerprint),
    };
}

export function projectAsset(asset: AssetManifestV1) {
    return {
        assetId: asset.assetId,
        kind: asset.kind,
        scope: asset.scope,
        ...(asset.projectId === "" ? {} : { projectId: asset.projectId }),
        scopePath: asset.scopePath,
        displayName: asset.displayName,
        displayDescription: asset.displayDescription,
        versionIds: [...asset.versionIds],
        deleted: asset.deleted,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
    };
}

export function projectAssetVersion(bundle: AssetVersionBundle) {
    return projectAssetVersionManifest(bundle.manifest);
}

export function projectAssetVersionManifest(manifest: AssetVersionManifestV2) {
    const importSource = (() => {
        if (manifest.originAuthority.originKind !== "import") return {};
        const importedManifest = manifest as typeof manifest & {
            readonly importProvenanceAuthority: ImportProvenanceAuthority;
        };
        if (importedManifest.importProvenanceAuthority.schemaVersion !== 2) return {};
        const sourceSnapshot = importedManifest.importProvenanceAuthority.sourceSnapshot;
        const roots = sourceSnapshot.roots.map((root) => ({
            sourceRootId: root.sourceRootId,
            rootRole: root.rootRole,
            sourceDomain: root.sourceDomain,
            canonicalPath: root.path,
        }));
        const files = sourceSnapshot.entries.flatMap((entry) =>
            entry.entryKind === "file"
                ? [
                      {
                          sourceRootId: entry.sourceRootId,
                          relativePath: entry.relativePath,
                          contentHash: toProtocolSha256(entry.contentHash),
                      },
                  ]
                : [],
        );
        const [firstRoot, ...remainingRoots] = roots;
        const [firstFile, ...remainingFiles] = files;
        if (firstRoot === undefined || firstFile === undefined) return {};
        return {
            importSource: {
                adapterId: sourceSnapshot.adapterId,
                sourceSnapshotFingerprint: toProtocolSha256(sourceSnapshot.snapshotFingerprint),
                roots: [firstRoot, ...remainingRoots] as const,
                files: [firstFile, ...remainingFiles] as const,
            },
        };
    })();
    return {
        assetId: manifest.assetId,
        versionId: manifest.versionId,
        revision: manifest.revision,
        status: manifest.status,
        versionCanonicalContentFingerprint: toProtocolSha256(manifest.versionCanonicalContentFingerprint),
        files: manifest.files.map((file) => ({
            fileId: file.fileId,
            logicalPath: file.logicalPath,
            role: file.role,
            mediaType: file.mediaType,
            contentKind: file.contentKind,
            contentHash: toProtocolSha256(file.contentHash),
            byteLength: file.byteSize,
            executable: file.executable,
        })),
        ...importSource,
        createdAt: manifest.createdAt,
    };
}

export function projectDeployment(deployment: DeploymentView) {
    return {
        deploymentId: deployment.deploymentId,
        subject:
            deployment.projectId === ""
                ? { subjectKind: "global" as const }
                : { subjectKind: "project" as const, projectId: deployment.projectId },
        consumerAgentRuntimeIds: [...deployment.consumerAgentRuntimeIds],
        environment: {
            platform: deployment.platform,
            platformInstanceId: deployment.platformInstanceId,
        },
        targetRootPath: deployment.targetRootPath,
        stage: deployment.derivedStatus.stage,
        reason: deployment.derivedStatus.reason,
        actionHints: [...deployment.derivedStatus.actionHints],
        freshness: {
            state: deployment.observationState,
            attemptedAt: deployment.observationAttemptedAt,
            lastCompleteAt: deployment.lastCompleteObservationAt,
        },
        deleted: deployment.deleted,
        assets: deployment.assets.map((asset) => ({
            assetId: asset.assetId,
            versionId: asset.versionId,
            allowIncomplete: asset.allowIncomplete,
        })),
        createdAt: deployment.createdAt,
        updatedAt: deployment.updatedAt,
    };
}
