/** Codex project/global Skill targets over the Core exact-native graph contract. */

import {
    defineDialectComponentV1 as component,
    adapterOperationDiagnostic as diagnostic,
    sha256SourceBytes,
} from "@oaam/adapter-framework";
import {
    type AdapterRenderAnalysisResult,
    type AgentRuntimeDescriptor,
    createNativeGlobalExactGraphProviderSupport,
    createNativeProjectExactGraphProviderSupport,
    createVerifiedNativeGlobalExactGraphBuild,
    createVerifiedNativeProjectExactGraphBuild,
    type NativeGlobalExactGraphProviderSupport,
    type NativeProjectExactGraphProviderSupport,
    type NativeProjectExactGraphRebaseInput,
    type NativeProjectExactGraphRebaseMaterializer,
    type PosixRelativePath,
    type RenderAnalysisInput,
    type RenderNativeRepresentationFileInput,
} from "@oaam/core/adapter-spi";
import { codexCanonicalSkillDeclaration, createCodexCanonicalSkillMaterializer } from "./codex-target-canonical-skill";
import { parseCodexFrontmatter } from "./codex-frontmatter";
import { CODEX_CURRENT_BUILDS } from "./codex-runtime-builds";
import { isCanonicalNativeRelativePath } from "./codex-source-read-foundation";
import { CODEX_NATIVE_DIALECTS } from "./codex-source-read-model";
import { validateCodexNativeDialect } from "./codex-source-read-native";
import { codexTargetBuildCompatibilityFor } from "./codex-target-build-compatibility";

type CodexRuntime = "CODEX_CLI" | "CODEX_APP";
type CodexSkillGraphSupports = Record<
    CodexRuntime,
    { project: NativeProjectExactGraphProviderSupport; global: NativeGlobalExactGraphProviderSupport }
>;

const ENTRY_NAME = "SKILL.md";
const DIRECTORY_TARGET_KIND_FACT = { "oaam.target-kind": "directory" } as const;

export const CODEX_SKILL_GRAPH_TARGET_COMPONENTS = {
    project: component("codex.project-skill-directory-graph-v1"),
    global: component("codex.global-skill-directory-graph-v1"),
    reverse: component(`${CODEX_NATIVE_DIALECTS.skill}.native-to-canonical-parser`),
    rebase: component("codex.skill-directory-parent-rebase-v1"),
} as const;

interface CodexSkillGraphRuntimeSpec {
    agentRuntimeId: CodexRuntime;
    versionText: string;
    buildIdentity: `sha256:${string}`;
    platform: "wsl" | "win32";
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
    outputPrefix: string;
    profilePrefix: string;
    capabilityPrefix: string;
    fixturePrefix: string;
}

const RUNTIME_SPECS: Record<CodexRuntime, CodexSkillGraphRuntimeSpec> = {
    CODEX_CLI: {
        agentRuntimeId: "CODEX_CLI",
        versionText: CODEX_CURRENT_BUILDS.CODEX_CLI.versionText,
        buildIdentity: CODEX_CURRENT_BUILDS.CODEX_CLI.buildIdentity,
        platform: CODEX_CURRENT_BUILDS.CODEX_CLI.platform,
        projectTargetContextSchemaId: "CODEX_CLI_PROJECT_GUIDANCE_TARGET_V1",
        globalTargetContextSchemaId: "CODEX_CLI_GLOBAL_SKILL_DIRECTORY_TARGET_V1",
        outputPrefix: "CODEX_NATIVE",
        profilePrefix: "codex-cli",
        capabilityPrefix: "codex.cli",
        fixturePrefix: CODEX_CURRENT_BUILDS.CODEX_CLI.fixturePrefix,
    },
    CODEX_APP: {
        agentRuntimeId: "CODEX_APP",
        versionText: CODEX_CURRENT_BUILDS.CODEX_APP.versionText,
        buildIdentity: CODEX_CURRENT_BUILDS.CODEX_APP.buildIdentity,
        platform: CODEX_CURRENT_BUILDS.CODEX_APP.platform,
        projectTargetContextSchemaId: "CODEX_APP_PROJECT_SKILL_TARGET_V1",
        globalTargetContextSchemaId: "CODEX_APP_GLOBAL_SKILL_DIRECTORY_TARGET_V1",
        outputPrefix: "CODEX_APP_NATIVE",
        profilePrefix: "codex-app",
        capabilityPrefix: "codex.app",
        fixturePrefix: CODEX_CURRENT_BUILDS.CODEX_APP.fixturePrefix,
    },
};

export function createCodexSkillGraphTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    canonicalSkills?: boolean;
    requiresNativeSourceAssessment?: boolean;
}): CodexSkillGraphSupports {
    return {
        CODEX_CLI: createRuntimeSupports(RUNTIME_SPECS.CODEX_CLI, input),
        CODEX_APP: createRuntimeSupports(RUNTIME_SPECS.CODEX_APP, input),
    };
}

export async function analyzeCodexSkillGraphTargets(
    input: RenderAnalysisInput,
    supports: CodexSkillGraphSupports[CodexRuntime],
): Promise<AdapterRenderAnalysisResult> {
    const scopes = new Set(input.deployment.assets.map((asset) => asset.scope));
    if (scopes.size === 1 && scopes.has("project")) return supports.project.analyze(input);
    if (scopes.size === 1 && scopes.has("global")) return supports.global.analyze(input);
    const unavailable = diagnostic(
        "render",
        "codex_skill_target_scope_ambiguous",
        "One Codex Skill Deployment must contain assets from one exact project or Global scope",
        "conflict",
        "error",
    );
    return {
        status: "failed",
        outputUnits: [],
        semanticOptions: [],
        blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: unavailable.code,
            diagnostics: [unavailable],
        })),
        diagnostics: [unavailable],
    };
}

function createRuntimeSupports(
    spec: CodexSkillGraphRuntimeSpec,
    input: {
        adapterVersion: string;
        agentRuntimes: readonly AgentRuntimeDescriptor[];
        canonicalSkills?: boolean;
        requiresNativeSourceAssessment?: boolean;
    },
): CodexSkillGraphSupports[CodexRuntime] {
    const projectPaths = [
        ".agents/skills/oaam-phase54-skill-graph/SKILL.md",
        ".agents/skills/oaam-phase54-skill-graph/assets/marker.bin",
        ".agents/skills/oaam-phase54-skill-graph/references/details.md",
        ".agents/skills/oaam-phase54-skill-graph/scripts/marker.py",
    ] as PosixRelativePath[];
    const globalPaths = [
        "oaam-phase54-global-skill-graph/SKILL.md",
        "oaam-phase54-global-skill-graph/assets/marker.bin",
        "oaam-phase54-global-skill-graph/references/details.md",
        "oaam-phase54-global-skill-graph/scripts/marker.py",
    ] as PosixRelativePath[];
    const projectProfile = `${spec.profilePrefix}-project-skill-directory-v1`;
    const globalProfile = `${spec.profilePrefix}-global-skill-directory-v1`;
    const projectBuild = createVerifiedNativeProjectExactGraphBuild({
        agentRuntimeId: spec.agentRuntimeId,
        versionText: spec.versionText,
        buildIdentity: spec.buildIdentity,
        platform: spec.platform,
        materializationProfileId: projectProfile,
        fixtureId: `${spec.fixturePrefix}-project-skill-directory-2026-08-05`,
        assetKind: "Skill",
        nativeDialectId: CODEX_NATIVE_DIALECTS.skill,
        projectGraphValidator: CODEX_SKILL_GRAPH_TARGET_COMPONENTS.project,
        reverseParser: CODEX_SKILL_GRAPH_TARGET_COMPONENTS.reverse,
        rebaseMaterializer: CODEX_SKILL_GRAPH_TARGET_COMPONENTS.rebase,
        ...(input.canonicalSkills === false
            ? {}
            : { canonicalMaterialization: codexCanonicalSkillDeclaration("project", input.requiresNativeSourceAssessment) }),
        restorationDialectIds: [],
        parentRebaseFixtureId: `${spec.fixturePrefix}-project-skill-directory-parent-rebase-v1`,
        targetGraphIdentity: projectPaths[0] as PosixRelativePath,
        targetRelativePaths: projectPaths,
        exactLoadMarker: `OAAM_PHASE54_${spec.agentRuntimeId}_PROJECT_SKILL_GRAPH`,
        reverseFixtureId: `${spec.fixturePrefix}-project-skill-directory-reverse-v1`,
    });
    const globalBuild = createVerifiedNativeGlobalExactGraphBuild({
        agentRuntimeId: spec.agentRuntimeId,
        versionText: spec.versionText,
        buildIdentity: spec.buildIdentity,
        platform: spec.platform,
        materializationProfileId: globalProfile,
        fixtureId: `${spec.fixturePrefix}-global-skill-directory-2026-08-05`,
        assetKind: "Skill",
        nativeDialectId: CODEX_NATIVE_DIALECTS.skill,
        globalGraphValidator: CODEX_SKILL_GRAPH_TARGET_COMPONENTS.global,
        reverseParser: CODEX_SKILL_GRAPH_TARGET_COMPONENTS.reverse,
        rebaseMaterializer: CODEX_SKILL_GRAPH_TARGET_COMPONENTS.rebase,
        ...(input.canonicalSkills === false
            ? {}
            : { canonicalMaterialization: codexCanonicalSkillDeclaration("global", input.requiresNativeSourceAssessment) }),
        restorationDialectIds: [],
        parentRebaseFixtureId: `${spec.fixturePrefix}-global-skill-directory-parent-rebase-v1`,
        targetGraphIdentity: globalPaths[0] as PosixRelativePath,
        targetRelativePaths: globalPaths,
        exactLoadMarker: `OAAM_PHASE54_${spec.agentRuntimeId}_GLOBAL_SKILL_GRAPH`,
        reverseFixtureId: `${spec.fixturePrefix}-global-skill-directory-reverse-v1`,
    });
    const common = {
        adapterId: "CODEX" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: "Skill" as const,
        nativeDialectId: CODEX_NATIVE_DIALECTS.skill,
        reverseParser: {
            ref: CODEX_SKILL_GRAPH_TARGET_COMPONENTS.reverse,
            parse: parseChangedCodexSkillFile,
        },
        rebaseMaterializer: CODEX_SKILL_GRAPH_REBASE_MATERIALIZER,
        restorationDialectIds: [],
        buildCompatibility: codexTargetBuildCompatibilityFor(spec.agentRuntimeId),
    };
    return {
        project: createNativeProjectExactGraphProviderSupport({
            ...common,
            ...(input.canonicalSkills === false
                ? {}
                : {
                      canonicalMaterializer: createCodexCanonicalSkillMaterializer(
                          "project",
                          spec.agentRuntimeId,
                          input.requiresNativeSourceAssessment,
                      ),
                  }),
            outputContractId: `${spec.outputPrefix}_PROJECT_SKILL_DIRECTORY_V1`,
            materializationProfileId: projectProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-project-skill-exact-graph-v1`,
            projectGraphValidator: {
                ref: CODEX_SKILL_GRAPH_TARGET_COMPONENTS.project,
                project: projectCodexProjectSkillGraph,
            },
            target: { targetContextSchemaId: spec.projectTargetContextSchemaId, requiredFacts: {} },
            verifiedBuilds: [projectBuild],
        }),
        global: createNativeGlobalExactGraphProviderSupport({
            ...common,
            ...(input.canonicalSkills === false
                ? {}
                : {
                      canonicalMaterializer: createCodexCanonicalSkillMaterializer(
                          "global",
                          spec.agentRuntimeId,
                          input.requiresNativeSourceAssessment,
                      ),
                  }),
            outputContractId: `${spec.outputPrefix}_GLOBAL_SKILL_DIRECTORY_V1`,
            materializationProfileId: globalProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-global-skill-exact-graph-v1`,
            globalGraphValidator: {
                ref: CODEX_SKILL_GRAPH_TARGET_COMPONENTS.global,
                validate: projectCodexGlobalSkillGraph,
            },
            target: {
                targetContextSchemaId: spec.globalTargetContextSchemaId,
                requiredFacts: DIRECTORY_TARGET_KIND_FACT,
            },
            verifiedBuilds: [globalBuild],
        }),
    };
}

export const CODEX_SKILL_GRAPH_REBASE_MATERIALIZER: NativeProjectExactGraphRebaseMaterializer = {
    ref: CODEX_SKILL_GRAPH_TARGET_COMPONENTS.rebase,
    materialize: materializeCodexSkillParentGraph,
};

function projectCodexProjectSkillGraph(files: readonly RenderNativeRepresentationFileInput[]) {
    return projectCodexSkillGraph(files, "project");
}

function projectCodexGlobalSkillGraph(files: readonly RenderNativeRepresentationFileInput[]) {
    return projectCodexSkillGraph(files, "global");
}

function projectCodexSkillGraph(files: readonly RenderNativeRepresentationFileInput[], scope: "project" | "global") {
    if (files.length === 0) return null;
    const paths = files.map((file) => file.relativePath);
    if (new Set(paths).size !== paths.length) return null;
    const entries = paths.filter((relativePath) => relativePath.endsWith(`/${ENTRY_NAME}`));
    if (entries.length !== 1) return null;
    const entryPath = entries[0] as PosixRelativePath;
    const boundary = entryPath.slice(0, -(ENTRY_NAME.length + 1));
    if (!isCodexSkillBoundary(boundary, scope) || paths.some((path) => !isStrictDescendant(path, boundary))) return null;
    return {
        graphIdentityRelativePath: entryPath,
        files: paths.map((nativeRelativePath) => ({
            nativeRelativePath,
            canonicalLogicalPath: nativeRelativePath.slice(boundary.length + 1) as PosixRelativePath,
        })),
        managedDirectoryBoundaries: [boundary as PosixRelativePath],
    };
}

function materializeCodexSkillParentGraph(
    input: NativeProjectExactGraphRebaseInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== CODEX_NATIVE_DIALECTS.skill ||
        input.targetCanonical.kind !== "Skill" ||
        input.restorationInputs.length !== 0
    ) {
        return null;
    }
    const projections = (["project", "global"] as const)
        .map((scope) => projectCodexSkillGraph(input.parent.files, scope))
        .filter((projection) => projection !== null);
    if (projections.length !== 1) return null;
    const projection = projections[0];
    if (projection === null || projection.files.length !== input.targetFiles.length) return null;
    const nativePathByLogicalPath = new Map(
        projection.files.map((mapping) => [mapping.canonicalLogicalPath, mapping.nativeRelativePath]),
    );
    const parentByPath = new Map(input.parent.files.map((file) => [file.relativePath, file]));
    if (
        nativePathByLogicalPath.size !== input.targetFiles.length ||
        input.targetFiles.some((file) => !nativePathByLogicalPath.has(file.file.logicalPath))
    ) {
        return null;
    }

    const nativeFiles: RenderNativeRepresentationFileInput[] = [];
    for (const target of input.targetFiles) {
        const relativePath = nativePathByLogicalPath.get(target.file.logicalPath);
        const parent = relativePath === undefined ? undefined : parentByPath.get(relativePath);
        if (relativePath === undefined || parent === undefined || parent.contentKind !== target.contentKind) return null;
        if (target.file.role === "entry") {
            if (target.file.logicalPath !== ENTRY_NAME || target.contentKind !== "text" || parent.contentKind !== "text") {
                return null;
            }
            const split = splitSkillDocument(parent.text);
            if (split === null) return null;
            nativeFiles.push(
                textNativeFile(relativePath, `${split.prefix}${target.text}`, target.file.mediaType, target.file.executable),
            );
        } else if (target.contentKind === "text") {
            nativeFiles.push(textNativeFile(relativePath, target.text, target.file.mediaType, target.file.executable));
        } else {
            nativeFiles.push(binaryNativeFile(relativePath, target.bytes, target.file.mediaType, target.file.executable));
        }
    }
    nativeFiles.sort((left, right) => compareText(left.relativePath, right.relativePath));
    return validatesRebasedGraph(input, nativeFiles) ? { nativeFiles } : null;
}

function parseChangedCodexSkillFile(input: {
    assetKind: "Skill";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}) {
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== CODEX_NATIVE_DIALECTS.skill ||
        input.appliedContent.contentKind !== input.currentContent.contentKind
    ) {
        return null;
    }
    if (input.relativePath.endsWith(`/${ENTRY_NAME}`)) {
        if (input.appliedContent.contentKind !== "text" || input.currentContent.contentKind !== "text") return null;
        const applied = splitSkillDocument(input.appliedContent.text);
        const current = splitSkillDocument(input.currentContent.text);
        return applied === null || current === null || applied.prefix !== current.prefix
            ? null
            : { canonicalContent: { contentKind: "text" as const, text: current.body } };
    }
    return input.currentContent.contentKind === "text"
        ? { canonicalContent: { contentKind: "text" as const, text: input.currentContent.text } }
        : { canonicalContent: { contentKind: "binary" as const, bytes: new Uint8Array(input.currentContent.bytes) } };
}

function splitSkillDocument(nativeText: string): { prefix: string; body: string } | null {
    const parsed = parseCodexFrontmatter(nativeText);
    if (!parsed.hasFrontmatter || !parsed.closed || parsed.diagnostics.length !== 0 || parsed.body.trim() === "") return null;
    return { prefix: nativeText.slice(0, nativeText.length - parsed.body.length), body: parsed.body };
}

function isCodexSkillBoundary(value: string, scope: "project" | "global"): boolean {
    if (!isCanonicalNativeRelativePath(value)) return false;
    const segments = value.split("/");
    if (scope === "global") return segments.length === 1 && segments[0] !== ".system";
    return (
        segments.length === 3 &&
        ((segments[0] === ".agents" && segments[1] === "skills") || (segments[0] === ".codex" && segments[1] === "skills")) &&
        segments[2] !== ".system"
    );
}

function isStrictDescendant(relativePath: string, boundary: string): boolean {
    return isCanonicalNativeRelativePath(relativePath) && relativePath.startsWith(`${boundary}/`);
}

function validatesRebasedGraph(
    input: NativeProjectExactGraphRebaseInput,
    nativeFiles: RenderNativeRepresentationFileInput[],
): boolean {
    return validateCodexNativeDialect({
        canonical: input.targetCanonical,
        canonicalFiles: input.targetFiles,
        representation: { ...input.parent.representation, files: nativeFiles.map(nativeDescriptor) },
        nativeFiles: nativeFiles.map((file) => ({
            relativePath: file.relativePath,
            bytes: file.contentKind === "text" ? new TextEncoder().encode(file.text) : new Uint8Array(file.bytes),
        })),
    });
}

function nativeDescriptor(file: RenderNativeRepresentationFileInput) {
    const {
        text: _text,
        bytes: _bytes,
        ...descriptor
    } = file as RenderNativeRepresentationFileInput & {
        text?: string;
        bytes?: Uint8Array;
    };
    return descriptor;
}

function textNativeFile(relativePath: PosixRelativePath, text: string, mediaType: string, executable: boolean) {
    const bytes = new TextEncoder().encode(text);
    return {
        relativePath,
        contentKind: "text" as const,
        mediaType,
        executable,
        contentHash: sha256SourceBytes(bytes),
        byteSize: bytes.byteLength,
        text,
    };
}

function binaryNativeFile(relativePath: PosixRelativePath, source: Uint8Array, mediaType: string, executable: boolean) {
    const bytes = new Uint8Array(source);
    return {
        relativePath,
        contentKind: "binary" as const,
        mediaType,
        executable,
        contentHash: sha256SourceBytes(bytes),
        byteSize: bytes.byteLength,
        bytes,
    };
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
