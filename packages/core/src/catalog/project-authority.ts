/** Strict Project manifest authority. SQLite project_index remains a rebuildable projection. */

import * as path from "node:path";
import {
    SafeFilesystemError,
    durableEnsureDirectory,
    durableReplaceFile,
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
} from "@oaam/shared/filesystem";
import type { Diagnostic, ProjectManifestV1, Sha256Digest, UuidV4 } from "../types";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isNonNegativeInteger, isStrictObject, isUuidV4 } from "../foundation/validators";

const PROJECT_MANIFEST_FIELDS = [
    "schemaVersion",
    "projectId",
    "rootPath",
    "displayName",
    "deleted",
    "createdAt",
    "updatedAt",
] as const;

export interface ProjectManifestValidationResult {
    ok: boolean;
    diagnostics: Diagnostic[];
}

export function validateProjectManifest(value: unknown): ProjectManifestValidationResult {
    const diagnostics: Diagnostic[] = [];
    const error = (code: string, message: string): void => {
        diagnostics.push({ severity: "error", code, message, path: "", traceId: "" });
    };
    if (!isStrictObject(value)) {
        error("project.shape", "Project manifest must be a non-null object");
        return { ok: false, diagnostics };
    }
    const allowed = new Set<string>(PROJECT_MANIFEST_FIELDS);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) error("project.strict", `undeclared Project field: ${key}`);
    }
    for (const key of PROJECT_MANIFEST_FIELDS) {
        if (!(key in value)) error("project.missing", `missing Project field: ${key}`);
    }
    if (value.schemaVersion !== 1) error("project.schema_version", "schemaVersion must be 1");
    if (!isUuidV4(value.projectId)) error("project.id", "projectId must be UUID v4");
    if (
        typeof value.rootPath !== "string" ||
        value.rootPath.length === 0 ||
        value.rootPath.includes("\0") ||
        !path.isAbsolute(value.rootPath) ||
        path.normalize(value.rootPath) !== value.rootPath ||
        value.rootPath === path.parse(value.rootPath).root ||
        value.rootPath.endsWith(path.sep)
    ) {
        error("project.root_path", "rootPath must be a canonical non-root absolute path");
    }
    if (typeof value.displayName !== "string" || (value.displayName.length > 0 && value.displayName.trim().length === 0)) {
        error("project.display_name", "displayName may be empty but not blank");
    }
    if (typeof value.deleted !== "boolean") error("project.deleted", "deleted must be boolean");
    if (!isNonNegativeInteger(value.createdAt)) {
        error("project.created_at", "createdAt must be a non-negative integer");
    }
    if (!isNonNegativeInteger(value.updatedAt)) {
        error("project.updated_at", "updatedAt must be a non-negative integer");
    } else if (typeof value.createdAt === "number" && value.updatedAt < value.createdAt) {
        error("project.updated_at", "updatedAt must be >= createdAt");
    }
    return { ok: diagnostics.length === 0, diagnostics };
}

export function serializeProjectManifest(manifest: ProjectManifestV1): string {
    const ordered: Record<string, unknown> = {};
    for (const key of PROJECT_MANIFEST_FIELDS) ordered[key] = manifest[key];
    const validation = validateProjectManifest(ordered);
    if (!validation.ok) {
        throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
    }
    return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function projectManifestAuthorityFingerprint(manifest: ProjectManifestV1): Sha256Digest {
    return sha256Bytes(Buffer.from(serializeProjectManifest(manifest), "utf8"));
}

export function parseProjectManifest(json: string): ProjectManifestV1 {
    const parsed: unknown = JSON.parse(json);
    const validation = validateProjectManifest(parsed);
    if (!validation.ok) {
        throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
    }
    return parsed as ProjectManifestV1;
}

export function resolveProjectRoot(projectsRoot: string, projectId: UuidV4): string {
    if (!isUuidV4(projectId)) throw new Error("projectId must be UUID v4");
    return path.join(projectsRoot, projectId);
}

export function readProjectManifest(projectsRoot: string, projectId: UuidV4): ProjectManifestV1 | null {
    const file = path.join(resolveProjectRoot(projectsRoot, projectId), "project.json");
    try {
        const manifest = parseProjectManifest(Buffer.from(readRegularFileNoFollow(file).bytes).toString("utf8"));
        if (manifest.projectId !== projectId) {
            throw new Error("Project directory identity does not match project.json");
        }
        return manifest;
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return null;
        throw error;
    }
}

export function writeProjectManifest(projectsRoot: string, manifest: ProjectManifestV1): void {
    durableEnsureDirectory(path.dirname(projectsRoot), path.basename(projectsRoot));
    durableEnsureDirectory(projectsRoot, manifest.projectId);
    durableReplaceFile(
        path.join(resolveProjectRoot(projectsRoot, manifest.projectId), "project.json"),
        serializeProjectManifest(manifest),
    );
}

export function inventoryProjectAuthorityIds(projectsRoot: string): string[] {
    try {
        return inventoryDirectoryNoFollow(projectsRoot)
            .entries.filter((entry) => entry.identity.entryKind === "directory")
            .map((entry) => entry.relativeName)
            .sort(compareUtf8Bytes);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        throw error;
    }
}

export function acquireProjectAuthorityLocks(authorityLocksRoot: string, projectIds: readonly UuidV4[]): () => void {
    const ordered = [...new Set(projectIds)].sort(compareUtf8Bytes);
    for (const projectId of ordered) {
        if (!isUuidV4(projectId)) throw new Error("Project lock identity must be UUID v4");
    }
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "projects", ordered);
    if (release === null) throw new Error("Project authority is locked");
    return release;
}

export function acquireProjectCatalogLock(authorityLocksRoot: string): () => void {
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "projects", ["catalog"]);
    if (release === null) throw new Error("Project catalog is locked");
    return release;
}
