/** Claude Code Git-worktree identity only; deriving a base never authorizes reading that project. */

import { lstatSync, realpathSync, type Stats } from "node:fs";
import {
    canonicalHostPath,
    canonicalProviderHostPathWithinAccessRoot,
    hostPathApiFor,
    probeDiagnostic as diagnostic,
    resolveProviderHostPathReference,
} from "@oaam/adapter-framework";
import type { OperationDiagnostic, PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";

export interface RuntimeProjectBaseResolution {
    path: string;
    diagnostics: OperationDiagnostic[];
}

const MAX_GIT_CONTROL_FILE_BYTES = 64 * 1024;

/**
 * Match Claude Code's auto-memory identity: the canonical main Git root when
 * a trusted worktree chain exists, otherwise the authorized project path.
 * This only derives identity; it never turns the parent Git root into a read
 * source root.
 */
export async function resolveClaudeRuntimeProjectBase(
    projectRootPath: string,
    platformContext: PlatformContext,
    readControlFile: (filePath: string, maximumBytes: number) => Promise<string>,
    filesystem: {
        inspectMarker: (path: string) => Stats;
        canonicalize: (path: string) => string;
    } = { inspectMarker: lstatSync, canonicalize: realpathSync },
): Promise<RuntimeProjectBaseResolution> {
    const paths = hostPathApiFor(projectRootPath);
    if (paths === null) return { path: projectRootPath, diagnostics: [] };
    const gitRoot = findGitRoot(projectRootPath, platformContext, filesystem.inspectMarker);
    if (gitRoot === null) return { path: projectRootPath, diagnostics: [] };

    const gitMarker = paths.join(gitRoot, ".git");
    let marker: Stats;
    try {
        marker = filesystem.inspectMarker(gitMarker);
    } catch {
        return { path: gitRoot, diagnostics: [] };
    }
    if (marker.isDirectory()) return { path: gitRoot, diagnostics: [] };
    if (!marker.isFile()) {
        return untrustedWorktreeBase(gitRoot, gitMarker);
    }

    try {
        const readControl = async (filePath: string): Promise<string> =>
            (await readControlFile(filePath, MAX_GIT_CONTROL_FILE_BYTES)).trim();
        const markerText = await readControl(gitMarker);
        if (!markerText.startsWith("gitdir:")) return { path: gitRoot, diagnostics: [] };
        const worktreeGitDir = resolveHostControlPath(gitRoot, markerText.slice("gitdir:".length).trim(), platformContext);
        const commonDirText = await readControl(paths.join(worktreeGitDir, "commondir"));
        const commonDir = resolveHostControlPath(worktreeGitDir, commonDirText, platformContext);
        if (paths.resolve(paths.dirname(worktreeGitDir)) !== paths.join(commonDir, "worktrees")) {
            return untrustedWorktreeBase(gitRoot, gitMarker);
        }
        const backlinkText = await readControl(paths.join(worktreeGitDir, "gitdir"));
        const backlinkPath = resolveHostControlPath(worktreeGitDir, backlinkText, platformContext);
        const backlink = canonicalHostPath(filesystem.canonicalize(backlinkPath));
        const realGitRoot = canonicalHostPath(filesystem.canonicalize(gitRoot));
        if (backlink === null || realGitRoot === null || backlink !== paths.join(realGitRoot, ".git")) {
            return untrustedWorktreeBase(gitRoot, gitMarker);
        }
        const canonical = paths.basename(commonDir) === ".git" ? paths.dirname(commonDir) : commonDir;
        return { path: canonicalHostPath(canonical) ?? gitRoot, diagnostics: [] };
    } catch (error) {
        // A .git file without commondir is a normal submodule. Other malformed
        // control files also fail closed to the authorized Git root.
        const failure = inspectFilesystemFailure(error);
        if (failure.failureKind === "not_found" || (failure.source === "node_errno_error" && failure.systemCode === "ENOTDIR")) {
            return { path: gitRoot, diagnostics: [] };
        }
        return untrustedWorktreeBase(gitRoot, gitMarker);
    }
}

function findGitRoot(startPath: string, platformContext: PlatformContext, inspectMarker: (path: string) => Stats): string | null {
    const accessRoot = canonicalProviderHostPathWithinAccessRoot(platformContext.accessRootPath, platformContext);
    if (accessRoot === null || canonicalProviderHostPathWithinAccessRoot(startPath, platformContext) === null) return null;
    const paths = hostPathApiFor(startPath);
    if (paths === null) return null;
    let current = paths.resolve(startPath);
    while (true) {
        try {
            const marker = inspectMarker(paths.join(current, ".git"));
            if (marker.isDirectory() || marker.isFile()) return current.normalize("NFC");
        } catch {
            // A missing/inaccessible marker at this level is not proof that a
            // parent is not the project root; continue exactly as the runtime.
        }
        if (current === accessRoot) return null;
        const parent = paths.dirname(current);
        if (parent === current || canonicalProviderHostPathWithinAccessRoot(parent, platformContext) === null) return null;
        current = parent;
    }
}

function untrustedWorktreeBase(projectRootPath: string, gitMarker: string): RuntimeProjectBaseResolution {
    return {
        path: projectRootPath,
        diagnostics: [
            diagnostic(
                "claudecode_git_worktree_identity_untrusted",
                "Claude Code worktree identity metadata failed structural validation; using the authorized Git root",
                "invalid_schema",
                "warning",
                gitMarker,
            ),
        ],
    };
}

function resolveHostControlPath(base: string, value: string, context: PlatformContext): string {
    const resolved = resolveProviderHostPathReference(base, value, context);
    if (resolved === null) throw new TypeError("Claude Code Git control path crosses the selected environment");
    return resolved;
}
