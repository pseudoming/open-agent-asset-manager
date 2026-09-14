/** Exact Linux package binding; physical code placement does not select the execution backend. */
import { posix } from "node:path";
import { requireRestrictedArtifactManifest, type RestrictedArtifactManifest } from "./restricted-artifact-package";
import { verifyRestrictedCodeInventory } from "./restricted-code-inventory";

export { RestrictedCodePackageError } from "./restricted-code-inventory";

export interface RestrictedCodePackage {
    readonly rootPath: string;
    readonly manifest: RestrictedArtifactManifest;
}

export function requireRestrictedCodePackage(value: unknown): asserts value is RestrictedCodePackage {
    if (value === null || typeof value !== "object" || Object.keys(value).sort().join(",") !== "manifest,rootPath")
        throw new Error("invalid restricted code package binding");
    const code = value as RestrictedCodePackage;
    if (
        typeof code.rootPath !== "string" ||
        !code.rootPath.startsWith("/") ||
        code.rootPath === "/" ||
        code.rootPath.includes("\0") ||
        posix.normalize(code.rootPath) !== code.rootPath ||
        code.rootPath.endsWith("/")
    )
        throw new Error("restricted code root must be one canonical absolute path");
    requireRestrictedArtifactManifest(code.manifest);
}

/** Execution compatibility always belongs to the actual Linux process, regardless of code placement. */
export function requireRestrictedCodeExecution(code: RestrictedCodePackage): void {
    requireRestrictedCodePackage(code);
    if (
        process.platform !== "linux" ||
        code.manifest.architecture !== process.arch ||
        code.manifest.nodeVersion !== process.versions.node ||
        code.manifest.nodeModulesVersion !== process.versions.modules
    )
        throw new Error("restricted code package target does not match its executing Node");
}

/** A package stored in Linux still receives the original complete local verification. */
export function verifyRestrictedCodePackage(code: RestrictedCodePackage): void {
    requireRestrictedCodeExecution(code);
    verifyRestrictedCodeInventory(code.rootPath, code.manifest, posix, true);
}
