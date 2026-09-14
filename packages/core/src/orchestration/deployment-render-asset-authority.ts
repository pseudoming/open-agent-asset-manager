import { readAssetManifest } from "../catalog/asset-manifest";
import { readProjectManifest } from "../catalog/project-authority";
import { readVersionAuthority } from "../catalog/version-authority";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import { projectVersionDialectInputs } from "../render/render-dialect-authority";
import type { RenderVersionDialectInputs, RenderAssetInput, UuidV4 } from "../types";
import { DeploymentRenderFailure } from "./deployment-render-action-authority";

interface RenderAssetAuthorityConfiguration {
    readonly assetsRoot: string;
    readonly projectsRoot: string;
    readonly dialectRegistry: VersionDialectRegistryV1;
}

export interface RenderAssetSelection {
    readonly assetId: UuidV4;
    readonly versionId: UuidV4;
    readonly allowIncomplete: boolean;
}

export function loadProjectRootPath(configuration: RenderAssetAuthorityConfiguration, projectId: string): string {
    if (projectId === "") return "";
    const project = readProjectManifest(configuration.projectsRoot, projectId);
    if (project === null || project.deleted) {
        throw new DeploymentRenderFailure(
            "render.project_unavailable",
            "Deployment Project is missing or deleted",
            "not_found",
            false,
            [],
        );
    }
    return project.rootPath;
}

export function loadRenderAssetAuthorities(
    configuration: RenderAssetAuthorityConfiguration,
    projectId: string,
    selections: readonly RenderAssetSelection[],
): { readonly assets: RenderAssetInput[]; readonly dialectInputs: RenderVersionDialectInputs[] } {
    const expectedScope = projectId === "" ? "global" : "project";
    const dialectInputs: RenderVersionDialectInputs[] = [];
    const assets = selections.map((item): RenderAssetInput => {
        const asset = readAssetManifest(configuration.assetsRoot, item.assetId);
        const closure = readVersionAuthority(
            configuration.assetsRoot,
            item.assetId,
            item.versionId,
            configuration.dialectRegistry,
        );
        if (
            asset === null ||
            asset.deleted ||
            closure === null ||
            asset.scope !== expectedScope ||
            asset.projectId !== projectId ||
            asset.scopePath !== "" ||
            asset.kind !== closure.manifest.kind
        ) {
            throw new DeploymentRenderFailure(
                "render.version_authority_stale",
                "Deployment Asset/Version authority is missing or outside the Deployment target scope",
                "conflict",
                true,
                [],
            );
        }
        const parent =
            closure.manifest.sourceVersionId === ""
                ? undefined
                : readVersionAuthority(
                      configuration.assetsRoot,
                      item.assetId,
                      closure.manifest.sourceVersionId,
                      configuration.dialectRegistry,
                  );
        const projectedDialectInputs = projectVersionDialectInputs(
            { assetId: item.assetId, versionId: item.versionId },
            {
                nativeRepresentations: closure.manifest.nativeRepresentations,
                dialectRestorationPayloads: closure.manifest.dialectRestorationPayloads,
                nativePayloads: closure.nativePayloads,
                restorationPayloads: closure.restorationPayloads,
            },
            parent
                ? {
                      sourceVersion: { assetId: item.assetId, versionId: closure.manifest.sourceVersionId },
                      closure: {
                          nativeRepresentations: parent.manifest.nativeRepresentations,
                          nativePayloads: parent.nativePayloads,
                      },
                  }
                : undefined,
        );
        if (projectedDialectInputs !== null) dialectInputs.push(projectedDialectInputs);
        return {
            scope: asset.scope,
            projectId: asset.projectId,
            scopePath: asset.scopePath,
            allowIncomplete: item.allowIncomplete,
            version: {
                ref: { assetId: item.assetId, versionId: item.versionId },
                versionFingerprint: closure.manifest.fingerprint,
                versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
                status: closure.manifest.status,
                canonical: {
                    kind: closure.manifest.kind,
                    typeData: structuredClone(closure.manifest.typeData),
                } as RenderAssetInput["version"]["canonical"],
                files: structuredClone(closure.files),
            },
            sectionHandles: Object.fromEntries(
                closure.files.map((file) => [file.file.fileId, `version:${item.versionId}:file:${file.file.fileId}`]),
            ),
        };
    });
    return { assets, dialectInputs };
}
