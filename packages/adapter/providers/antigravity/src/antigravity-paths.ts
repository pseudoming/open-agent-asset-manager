import { canonicalHostPath, hostPathApiFor, isWslUncHostPath } from "@oaam/adapter-framework";
import { getHomeDir } from "@oaam/shared/paths";
import type { Platform } from "@oaam/core";

/** Family-shared and entry-private Antigravity roots for one platform instance. */
export interface AntigravityPathRule {
    platform: Platform;
    familyRoot: string;
    sharedGuidancePath: string;
    sharedConfigRoot: string;
    sharedSkillsRoot: string;
    appDataRoot: string;
    cliDataRoot: string;
    ideDataRoot: string;
    appSummariesPath: string;
    ideSummariesPath: string;
    cliSettingsPath: string;
    cliSummariesDbPath: string;
    sharedProjectsRoot: string;
}

/**
 * Antigravity currently stores its user data below `~/.gemini` on the
 * verified Unix/WSL fixtures. The platform instance supplies the home path;
 * source roots are never inferred from cwd.
 */
export function getPathRule(platform: Platform, homeDir: string = getHomeDir()): AntigravityPathRule | null {
    const home = canonicalAbsolutePath(homeDir);
    if (home === null) return null;
    const paths = hostPathApiFor(home);
    if (paths === null) return null;
    const familyRoot = paths.join(home, ".gemini");
    const sharedConfigRoot = paths.join(familyRoot, "config");
    const appDataRoot = paths.join(familyRoot, "antigravity");
    const cliDataRoot = paths.join(familyRoot, "antigravity-cli");
    const ideDataRoot = paths.join(familyRoot, "antigravity-ide");
    return {
        platform,
        familyRoot,
        sharedGuidancePath: paths.join(familyRoot, "GEMINI.md"),
        sharedConfigRoot,
        sharedSkillsRoot: paths.join(familyRoot, "skills"),
        appDataRoot,
        cliDataRoot,
        ideDataRoot,
        appSummariesPath: paths.join(appDataRoot, "agyhub_summaries_proto.pb"),
        ideSummariesPath: paths.join(ideDataRoot, "agyhub_summaries_proto.pb"),
        cliSettingsPath: paths.join(cliDataRoot, "settings.json"),
        cliSummariesDbPath: paths.join(cliDataRoot, "conversation_summaries.db"),
        sharedProjectsRoot: paths.join(sharedConfigRoot, "projects"),
    };
}

export function canonicalAntigravityRoot(rawPath: string): string | null {
    return canonicalAbsolutePath(rawPath);
}

function canonicalAbsolutePath(rawPath: string): string | null {
    if (rawPath.trim() === "" || rawPath.includes("\0")) return null;
    const path = canonicalHostPath(rawPath);
    if (path === null) return null;
    return path.startsWith("\\\\") && !isWslUncHostPath(path) ? null : path;
}
