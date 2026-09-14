import { canonicalHostPath, hostPathApiFor, isWslUncHostPath } from "@oaam/adapter-framework";
import type { Platform, RootLocatorKind } from "@oaam/core";
import { getHomeDir } from "@oaam/shared/paths";

/** One resolved path with the exact non-secret rule that selected it. */
export interface ResolvedOpencodePath {
    path: string;
    locatorKind: Extract<RootLocatorKind, "runtime_known_rule" | "runtime_declared_path">;
    locatorKey: string;
}

/** OpenCode CLI path/feature rules consumed by probe and source reads. */
export interface OpencodePathRule {
    platform: Platform;
    globalConfigRoot: ResolvedOpencodePath;
    configRoots: ResolvedOpencodePath[];
    dataRoot: ResolvedOpencodePath;
    database: ResolvedOpencodePath | null;
    sharedSkillRoots: ResolvedOpencodePath[];
    claudeGuidanceRoot: ResolvedOpencodePath | null;
    projectConfigEnabled: boolean;
    externalSkillsEnabled: boolean;
    claudePromptEnabled: boolean;
    claudeSkillsEnabled: boolean;
}

export function getPathRule(
    platform: Platform,
    environment: NodeJS.ProcessEnv = process.env,
    homeDir: string = getHomeDir(),
): OpencodePathRule | null {
    const home = canonicalOpencodeAbsolutePath(homeDir);
    if (home === null) return null;
    const paths = hostPathApiFor(home);
    if (paths === null) return null;

    const configBase = resolveXdgBase(environment.XDG_CONFIG_HOME, paths.join(home, ".config"), "XDG_CONFIG_HOME");
    const dataBase = resolveXdgBase(environment.XDG_DATA_HOME, paths.join(home, ".local", "share"), "XDG_DATA_HOME");
    if (configBase === null || dataBase === null) return null;

    const defaultConfigRoot = withChild(configBase, "opencode", "opencode_config_default");
    const homeConfigRoot = known(paths.join(home, ".opencode"), "opencode_home_config");
    let globalConfigRoot = markGlobalConfigRoot(defaultConfigRoot);
    const declaredConfigRoots: ResolvedOpencodePath[] = [];
    const configOverride = nonBlank(environment.OPENCODE_CONFIG_DIR);
    if (configOverride !== undefined) {
        const canonical = canonicalOpencodeAbsolutePath(configOverride);
        if (canonical === null) return null;
        const override = declared(canonical, "OPENCODE_CONFIG_DIR");
        globalConfigRoot = markGlobalConfigRoot(override);
        declaredConfigRoots.push(override);
    }
    const configRoots = deduplicatePaths([globalConfigRoot, defaultConfigRoot, homeConfigRoot, ...declaredConfigRoots]);
    const dataRoot = withChild(dataBase, "opencode", "opencode_data_default");
    const database = resolveDatabase(environment.OPENCODE_DB, dataRoot.path);
    if (database === undefined) return null;

    const externalSkillsEnabled = !truthy(environment.OPENCODE_DISABLE_EXTERNAL_SKILLS);
    const claudePromptEnabled =
        !truthy(environment.OPENCODE_DISABLE_CLAUDE_CODE) && !truthy(environment.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT);
    const claudeSkillsEnabled =
        externalSkillsEnabled &&
        !truthy(environment.OPENCODE_DISABLE_CLAUDE_CODE) &&
        !truthy(environment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS);
    const sharedSkillRoots = externalSkillsEnabled
        ? [
              known(paths.join(home, ".agents", "skills"), "opencode_agents_shared_skills"),
              ...(claudeSkillsEnabled ? [known(paths.join(home, ".claude", "skills"), "opencode_claude_compat_skills")] : []),
          ]
        : [];
    return {
        platform,
        globalConfigRoot,
        configRoots,
        dataRoot,
        database,
        sharedSkillRoots,
        claudeGuidanceRoot: claudePromptEnabled ? known(paths.join(home, ".claude"), "opencode_claude_compat_guidance") : null,
        projectConfigEnabled: !truthy(environment.OPENCODE_DISABLE_PROJECT_CONFIG),
        externalSkillsEnabled,
        claudePromptEnabled,
        claudeSkillsEnabled,
    };
}

/** Encodes only non-secret feature gates needed by the provider read parser. */
export function projectSourceLocatorKey(rule: OpencodePathRule): string {
    return [
        "probe_project_root",
        rule.projectConfigEnabled ? "project_config_on" : "project_config_off",
        rule.externalSkillsEnabled ? "external_skills_on" : "external_skills_off",
        rule.claudePromptEnabled ? "claude_prompt_on" : "claude_prompt_off",
        rule.claudeSkillsEnabled ? "claude_skills_on" : "claude_skills_off",
    ].join(":");
}

function resolveXdgBase(override: string | undefined, fallback: string, locatorKey: string): ResolvedOpencodePath | null {
    const value = nonBlank(override);
    if (value === undefined) return known(fallback, `${locatorKey}_default`);
    const canonical = canonicalOpencodeAbsolutePath(value);
    return canonical === null ? null : declared(canonical, locatorKey);
}

function resolveDatabase(raw: string | undefined, dataRoot: string): ResolvedOpencodePath | null | undefined {
    const value = nonBlank(raw);
    const paths = hostPathApiFor(dataRoot);
    if (paths === null) return undefined;
    if (value === undefined) return known(paths.join(dataRoot, "opencode.db"), "opencode_database_default");
    if (value === ":memory:") return null;
    if (value.includes("\0")) return undefined;
    const path = paths.isAbsolute(value) ? value : paths.join(dataRoot, value);
    const canonical = canonicalOpencodeAbsolutePath(path);
    return canonical === null ? undefined : declared(canonical, "OPENCODE_DB");
}

function withChild(base: ResolvedOpencodePath, child: string, defaultLocatorKey: string): ResolvedOpencodePath {
    const paths = hostPathApiFor(base.path);
    if (paths === null) throw new TypeError("OpenCode base path must remain canonical absolute");
    return {
        path: paths.resolve(base.path, child),
        locatorKind: base.locatorKind,
        locatorKey: base.locatorKind === "runtime_declared_path" ? base.locatorKey : defaultLocatorKey,
    };
}

function known(path: string, locatorKey: string): ResolvedOpencodePath {
    const canonical = canonicalOpencodeAbsolutePath(path);
    if (canonical === null) throw new TypeError("OpenCode known path must remain canonical absolute");
    return { path: canonical, locatorKind: "runtime_known_rule", locatorKey };
}

function declared(path: string, locatorKey: string): ResolvedOpencodePath {
    return { path, locatorKind: "runtime_declared_path", locatorKey };
}

function markGlobalConfigRoot(value: ResolvedOpencodePath): ResolvedOpencodePath {
    return { ...value, locatorKey: `opencode_global_config:${value.locatorKey}` };
}

function deduplicatePaths(values: ResolvedOpencodePath[]): ResolvedOpencodePath[] {
    const seen = new Set<string>();
    return values.filter((value) => {
        if (seen.has(value.path)) return false;
        seen.add(value.path);
        return true;
    });
}

/** Applies the one OpenCode-family rule for canonical absolute host paths. */
export function canonicalOpencodeAbsolutePath(value: string): string | null {
    const canonical = canonicalHostPath(value);
    if (canonical === null) return null;
    return canonical.startsWith("\\\\") && !isWslUncHostPath(canonical) ? null : canonical;
}

function truthy(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
}

function nonBlank(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
