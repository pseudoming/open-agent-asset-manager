/** Required render-semantic derivation and deployment-input validation. */

import type { AssetVersionFileContentV2 } from "../contracts/asset-version";
import type { RenderSemanticKind, RenderSemanticSubject, RequiredRenderSemantic } from "../contracts/deployment-authority";
import type { RenderAnalysisInput, RenderDeploymentInput, SemanticRenderOption } from "../contracts/render";
import type { AssetKind } from "../contracts/primitives";
import {
    computeRenderInputFingerprint,
    computeSemanticRefFingerprint,
    computeVersionCanonicalContentFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import type { RenderRegistrySnapshot } from "./render-registry";
import { BUILTIN_ASSET_KINDS, getAssetSpecHandler } from "../specs/registry";
import { isCanonicalRelativePath, isCanonicalTargetRootPath, isSha256Digest, isUuidV4 } from "../foundation/validators";
import { binaryPayloadStats, canonicalMediaType, normalizeText, textPayloadStats } from "../catalog/payload-store";
import { RenderAnalysisFailure, compareUtf8Bytes } from "./render-analysis-shared";

export function deriveRequiredRenderSemanticsV1(deployment: RenderDeploymentInput): RequiredRenderSemantic[] {
    const result: RequiredRenderSemantic[] = [];
    for (const consumerAgentRuntimeId of deployment.consumerAgentRuntimeIds) {
        for (const asset of deployment.assets) {
            const kind = asset.version.canonical.kind;
            for (const semanticKind of assetSemanticKinds(kind)) {
                result.push(
                    requiredSemantic(
                        consumerAgentRuntimeId,
                        {
                            subjectKind: "asset",
                            assetId: asset.version.ref.assetId,
                            versionId: asset.version.ref.versionId,
                        },
                        semanticKind,
                    ),
                );
            }

            const entryFiles = asset.version.files.filter((file) => file.file.role === "entry");
            if (
                asset.version.status === "incomplete" &&
                getAssetSpecHandler(kind).completeEntryRule(asset.version.canonical) === "one_text" &&
                entryFiles.length === 0
            ) {
                result.push(
                    requiredSemantic(
                        consumerAgentRuntimeId,
                        {
                            subjectKind: "missing_required_file_role",
                            assetId: asset.version.ref.assetId,
                            versionId: asset.version.ref.versionId,
                            fileRole: "entry",
                        },
                        entrySemanticKind(kind),
                    ),
                );
            }
            for (const file of asset.version.files) {
                for (const semanticKind of fileSemanticKinds(kind, file)) {
                    result.push(
                        requiredSemantic(
                            consumerAgentRuntimeId,
                            {
                                subjectKind: "file",
                                assetId: asset.version.ref.assetId,
                                versionId: asset.version.ref.versionId,
                                fileId: file.file.fileId,
                            },
                            semanticKind,
                        ),
                    );
                }
            }
        }
    }
    return result.sort((left, right) => compareUtf8Bytes(left.semanticRefFingerprint, right.semanticRefFingerprint));
}

export function validateRenderDeploymentInput(deployment: RenderDeploymentInput, registry: RenderRegistrySnapshot): void {
    if (deployment.schemaVersion !== 1 || !isUuidV4(deployment.deploymentId)) {
        throw new RenderAnalysisFailure("render.input_identity_invalid", "render deployment identity is invalid");
    }
    if (deployment.platformInstanceId.trim() === "" || deployment.platformInstanceId.includes("\0")) {
        throw new RenderAnalysisFailure(
            "render.environment_identity_invalid",
            "render platform instance identity must be non-blank and NUL-free",
        );
    }
    if (!isCanonicalTargetRootPath(deployment.targetRootPath, deployment.platform)) {
        throw new RenderAnalysisFailure("render.target_root_invalid", "render target root is not canonical absolute");
    }
    requireSortedUnique(deployment.consumerAgentRuntimeIds, "consumerAgentRuntimeIds");
    if (deployment.consumerAgentRuntimeIds.length === 0) {
        throw new RenderAnalysisFailure("render.consumer_missing", "render requires at least one consumer");
    }
    if (deployment.projectId !== "" && !isUuidV4(deployment.projectId)) {
        throw new RenderAnalysisFailure("render.project_invalid", "render projectId must be empty or UUID v4");
    }
    if (deployment.renderRegistryFingerprint !== registry.fingerprint) {
        throw new RenderAnalysisFailure("render.registry_stale", "render registry fingerprint is stale", "conflict", true);
    }
    const contexts = new Map<string, RenderDeploymentInput["targetContexts"][number]>();
    for (const context of deployment.targetContexts) {
        if (contexts.has(context.agentRuntimeId)) {
            throw new RenderAnalysisFailure("render.context_duplicate", "target context is duplicated");
        }
        registry.validateTargetContext(context);
        contexts.set(context.agentRuntimeId, context);
    }
    if (stableStringify([...contexts.keys()].sort(compareUtf8Bytes)) !== stableStringify(deployment.consumerAgentRuntimeIds)) {
        throw new RenderAnalysisFailure("render.context_cardinality", "target contexts must exactly match consumers");
    }
    const assetIds = new Set<string>();
    for (const asset of deployment.assets) {
        validateRenderAsset(asset, deployment.projectId);
        if (assetIds.has(asset.version.ref.assetId)) {
            throw new RenderAnalysisFailure("render.asset_duplicate", "render input repeats an Asset authority");
        }
        assetIds.add(asset.version.ref.assetId);
    }
    validateTargetFileSnapshots(deployment);
    const { renderInputFingerprint: _stored, ...preimage } = deployment;
    if (computeRenderInputFingerprint(preimage) !== deployment.renderInputFingerprint) {
        throw new RenderAnalysisFailure("render.input_fingerprint_mismatch", "render input fingerprint mismatch");
    }
}

function validateTargetFileSnapshots(deployment: RenderDeploymentInput): void {
    const snapshots = deployment.targetFileSnapshots;
    if (snapshots === undefined) return;
    if (
        snapshots.length === 0 ||
        snapshots.length > 16 ||
        !deployment.assets.some(
            (asset) => asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog",
        )
    ) {
        throw new RenderAnalysisFailure(
            "render.target_snapshot_closure_invalid",
            "target file snapshots require one bounded Memory Catalog closure",
        );
    }
    requireSortedUnique(
        snapshots.map((snapshot) => snapshot.relativePath),
        "targetFileSnapshots",
    );
    for (const snapshot of snapshots) {
        if (!isCanonicalRelativePath(snapshot.relativePath)) {
            throw new RenderAnalysisFailure("render.target_snapshot_path_invalid", "target file snapshot path is not canonical");
        }
        if (snapshot.snapshotState === "missing") {
            if (Object.keys(snapshot).length !== 2) {
                throw new RenderAnalysisFailure(
                    "render.target_snapshot_shape_invalid",
                    "missing target file snapshot contains extra authority",
                );
            }
            continue;
        }
        if (
            snapshot.snapshotState !== "present" ||
            Object.keys(snapshot).length !== 5 ||
            !isSha256Digest(snapshot.contentHash) ||
            !Number.isSafeInteger(snapshot.byteSize) ||
            snapshot.byteSize < 0 ||
            typeof snapshot.executable !== "boolean"
        ) {
            throw new RenderAnalysisFailure("render.target_snapshot_shape_invalid", "present target file snapshot is invalid");
        }
    }
}
export function validateRenderAsset(asset: RenderDeploymentInput["assets"][number], deploymentProjectId: string): void {
    if (
        (asset.scope !== "global" && asset.scope !== "project") ||
        asset.scope !== (asset.projectId === "" ? "global" : "project") ||
        (asset.scope === "global" && asset.scopePath !== "") ||
        (asset.scope === "project" && asset.projectId !== deploymentProjectId) ||
        (asset.scopePath !== "" && !isCanonicalRelativePath(asset.scopePath))
    ) {
        throw new RenderAnalysisFailure("render.asset_scope_invalid", "render asset scope/project/path is invalid");
    }
    if (typeof asset.allowIncomplete !== "boolean") {
        throw new RenderAnalysisFailure("render.asset_incomplete_policy_invalid", "render allowIncomplete must be a boolean");
    }
    if (!isUuidV4(asset.version.ref.assetId) || !isUuidV4(asset.version.ref.versionId)) {
        throw new RenderAnalysisFailure("render.version_ref_invalid", "render VersionRef is invalid");
    }
    if (!isSha256Digest(asset.version.versionFingerprint)) {
        throw new RenderAnalysisFailure("render.version_fingerprint_invalid", "render Version fingerprint is invalid");
    }
    if (asset.version.status !== "complete" && asset.version.status !== "incomplete") {
        throw new RenderAnalysisFailure("render.version_status_invalid", "render Version status is invalid");
    }
    if (asset.version.status === "incomplete" && !asset.allowIncomplete) {
        throw new RenderAnalysisFailure("render.incomplete_not_allowed", "incomplete Version is not allowed by Deployment input");
    }
    if (!BUILTIN_ASSET_KINDS.includes(asset.version.canonical.kind)) {
        throw new RenderAnalysisFailure("render.asset_kind_invalid", "render canonical AssetKind is invalid");
    }
    const handler = getAssetSpecHandler(asset.version.canonical.kind);
    if (!handler.isCanonicalPair(asset.version.canonical)) {
        throw new RenderAnalysisFailure("render.asset_type_data_invalid", "render canonical AssetKind/typeData pair is invalid");
    }
    const fileIds = new Set<string>();
    for (const content of asset.version.files) {
        validateRenderFile(content);
        if (fileIds.has(content.file.fileId)) {
            throw new RenderAnalysisFailure("render.file_id_duplicate", "render Version repeats a fileId");
        }
        fileIds.add(content.file.fileId);
    }
    if (asset.version.status === "complete") {
        const fileIssues = handler.validateFiles(asset.version.canonical, asset.version.files);
        const entryFiles = asset.version.files.filter((item) => item.file.role === "entry");
        const entryRule = handler.completeEntryRule(asset.version.canonical);
        if (
            fileIssues.length > 0 ||
            (entryRule === "zero" && entryFiles.length !== 0) ||
            (entryRule === "one_text" &&
                (entryFiles.length !== 1 ||
                    entryFiles[0]?.contentKind !== "text" ||
                    !handler.validateEntryText(entryFiles[0].text)))
        ) {
            throw new RenderAnalysisFailure(
                "render.complete_version_invalid",
                "complete render Version violates its AssetKind file contract",
            );
        }
    }
    if (
        stableStringify(Object.keys(asset.sectionHandles).sort(compareUtf8Bytes)) !==
            stableStringify([...fileIds].sort(compareUtf8Bytes)) ||
        Object.values(asset.sectionHandles).some((value) => value.trim().length === 0)
    ) {
        throw new RenderAnalysisFailure("render.section_handle_closure", "section handles must exactly cover Version files");
    }
    const expectedCanonical = computeVersionCanonicalContentFingerprint(
        asset.version.canonical,
        asset.version.files.map((item) => item.file),
    );
    if (expectedCanonical !== asset.version.versionCanonicalContentFingerprint) {
        throw new RenderAnalysisFailure("render.canonical_fingerprint_mismatch", "canonical Version fingerprint mismatch");
    }
}

export function validateRenderFile(content: AssetVersionFileContentV2): void {
    if (!isUuidV4(content.file.fileId) || !isCanonicalRelativePath(content.file.logicalPath)) {
        throw new RenderAnalysisFailure("render.file_identity_invalid", "render file identity/path is invalid");
    }
    if (content.contentKind !== content.file.contentKind) {
        throw new RenderAnalysisFailure("render.file_content_kind_mismatch", "render file content kind mismatch");
    }
    const stats = content.contentKind === "text" ? textPayloadStats(content.text) : binaryPayloadStats(content.bytes);
    if (
        stats.contentHash !== content.file.contentHash ||
        stats.byteSize !== content.file.byteSize ||
        canonicalMediaType(content.file.mediaType) !== content.file.mediaType ||
        (content.contentKind === "text" && normalizeText(content.text).normalized !== content.text)
    ) {
        throw new RenderAnalysisFailure("render.file_payload_mismatch", "render file bytes contradict their descriptor");
    }
}

export function requireSemanticAsset(
    input: RenderAnalysisInput,
    semantic: RequiredRenderSemantic,
): RenderAnalysisInput["deployment"]["assets"][number] {
    const key = semanticVersionKey(semantic.subject);
    const matches = input.deployment.assets.filter((item) => versionRefKey(item.version.ref) === key);
    if (matches.length !== 1) {
        throw new RenderAnalysisFailure(
            "render.semantic_asset_missing",
            "semantic subject does not resolve one projected Asset Version",
        );
    }
    return matches[0] as RenderAnalysisInput["deployment"]["assets"][number];
}

export function requiredSemantic(
    consumerAgentRuntimeId: string,
    subject: RenderSemanticSubject,
    semanticKind: RenderSemanticKind,
): RequiredRenderSemantic {
    const preimage = { consumerAgentRuntimeId, subject, semanticKind };
    return { ...preimage, semanticRefFingerprint: computeSemanticRefFingerprint(preimage) };
}

export function assetSemanticKinds(kind: AssetKind): RenderSemanticKind[] {
    switch (kind) {
        case "Guidance":
            return ["asset.file_inventory", "guidance.base_context"];
        case "Rule":
            return ["asset.file_inventory", "rule.activation"];
        case "Workflow":
            return ["asset.file_inventory", "workflow.activation"];
        case "Skill":
            return ["asset.file_inventory", "skill.discovery_metadata"];
        case "Subagent":
            return ["asset.file_inventory", "subagent.delegation_metadata", "subagent.tool_boundary", "subagent.model_hint"];
        case "Memory":
            return ["asset.file_inventory", "memory.support"];
    }
}

export function entrySemanticKind(kind: AssetKind): RenderSemanticKind {
    switch (kind) {
        case "Guidance":
            return "guidance.content";
        case "Rule":
            return "rule.content";
        case "Workflow":
            return "workflow.content";
        case "Skill":
            return "skill.body";
        case "Subagent":
            return "subagent.invoked_context";
        case "Memory":
            return "memory.content";
    }
}

export function fileSemanticKinds(kind: AssetKind, content: AssetVersionFileContentV2): RenderSemanticKind[] {
    switch (kind) {
        case "Guidance":
            return ["guidance.content"];
        case "Rule":
            return ["rule.content"];
        case "Workflow":
            return [
                "workflow.content",
                ...(content.file.references.length > 0 ? (["workflow.reference"] as RenderSemanticKind[]) : []),
            ];
        case "Skill":
            return [content.file.role === "entry" ? "skill.body" : "skill.resource"];
        case "Subagent":
            return [content.file.role === "entry" ? "subagent.invoked_context" : "subagent.resource"];
        case "Memory":
            return ["memory.content"];
    }
}

export function reversePolicyFits(declared: string, actual: SemanticRenderOption["actualReverseExtractPolicy"]): boolean {
    if (declared === "requires_user_choice") return true;
    return declared === actual;
}

export function versionRefKey(ref: { assetId: string; versionId: string }): string {
    return `${ref.assetId}\0${ref.versionId}`;
}

export function semanticVersionKey(subject: RenderSemanticSubject): string {
    return `${subject.assetId}\0${subject.versionId}`;
}

export function requireSortedUnique(values: readonly string[], label: string): void {
    if (
        values.length !== new Set(values).size ||
        stableStringify(values) !== stableStringify([...values].sort(compareUtf8Bytes))
    ) {
        throw new RenderAnalysisFailure("render.noncanonical_set", `${label} must be sorted unique`);
    }
}
