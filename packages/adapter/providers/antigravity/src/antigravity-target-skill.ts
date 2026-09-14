/** Antigravity exact-build project/global Skill targets over the exact native graph contract. */

import {
    defineDialectComponentV1 as component,
    adapterOperationDiagnostic as diagnostic,
    sha256SourceBytes,
    stableSourceValueEqual,
} from "@oaam/adapter-framework";
import {
    type AdapterRenderAnalysisResult,
    type CanonicalRenderEntryValidationInput,
    type AdapterTargetBuildCompatibilityPolicyV1,
    type AgentRuntimeDescriptor,
    type AgentRuntimeId,
    createNativeGlobalExactGraphProviderSupport,
    createNativeProjectExactGraphProviderSupport,
    createVerifiedNativeGlobalExactGraphBuild,
    createVerifiedNativeProjectExactGraphBuild,
    type NativeGlobalExactGraphProviderSupport,
    type NativeProjectExactGraphCanonicalMaterializationInput,
    type NativeProjectExactGraphCanonicalMaterializer,
    type NativeProjectExactGraphProviderSupport,
    type NativeProjectExactGraphRebaseInput,
    type NativeProjectExactGraphRebaseMaterializer,
    type Platform,
    type PosixRelativePath,
    type RenderAnalysisInput,
    type RenderNativeRepresentationFileInput,
    type SkillTypeDataV2,
} from "@oaam/core/adapter-spi";
import { parseAntigravityFrontmatter } from "./antigravity-frontmatter";
import { ANTIGRAVITY_NATIVE_DIALECTS } from "./antigravity-source-read-model";
import { validateAntigravityNativeDialect } from "./antigravity-source-read-native";
import {
    ANTIGRAVITY_APP_TARGET_BUILD_COMPATIBILITY,
    ANTIGRAVITY_CLI_TARGET_BUILD_COMPATIBILITY,
    ANTIGRAVITY_IDE_TARGET_BUILD_COMPATIBILITY,
} from "./antigravity-target-build-compatibility";

const ENTRY_NAME = "SKILL.md";
const PROJECT_TARGET_FACTS = { "oaam.project-binding": "registered" } as const;
const CANONICAL_DEGRADATIONS = [
    "permission_or_tool_boundary_lost",
    "runtime_specific_metadata_lost",
    "trigger_or_loading_level_lost",
] as const;

export interface AntigravitySkillTargetSupports {
    projectFolder: NativeProjectExactGraphProviderSupport;
    globalFolder: NativeGlobalExactGraphProviderSupport;
}

interface SkillRuntimeSpec {
    agentRuntimeId: AgentRuntimeId;
    profilePrefix: string;
    capabilityPrefix: string;
    outputPrefix: string;
    globalTargetContextSchemaId: string;
    buildCompatibility: AdapterTargetBuildCompatibilityPolicyV1;
    projectFixtureName: string;
    globalFixtureName: string;
    projectLoadMarker: string;
    globalLoadMarker: string;
    verifiedBuilds: readonly {
        versionText: string;
        buildIdentity: `sha256:${string}`;
        platform: Platform;
        fixturePrefix: string;
    }[];
}

const CLI_SKILL_SPEC = {
    agentRuntimeId: "ANTIGRAVITY_CLI",
    profilePrefix: "antigravity-cli",
    capabilityPrefix: "antigravity.cli",
    outputPrefix: "ANTIGRAVITY",
    globalTargetContextSchemaId: "ANTIGRAVITY_CLI_GLOBAL_SKILL_TARGET_V1",
    buildCompatibility: ANTIGRAVITY_CLI_TARGET_BUILD_COMPATIBILITY,
    projectFixtureName: "oaam-phase55-skill-graph",
    globalFixtureName: "oaam-phase55-global-skill",
    projectLoadMarker: "OAAM_PHASE55_ANTIGRAVITY_PROJECT_FOLDER_SKILL",
    globalLoadMarker: "OAAM_PHASE55_ANTIGRAVITY_GLOBAL_FOLDER_SKILL",
    verifiedBuilds: [
        {
            versionText: "1.1.10",
            buildIdentity: "sha256:4217db798fd514cedce4e315013daea471a1a67666ab91547b2ad0dbee167a71",
            platform: "wsl",
            fixturePrefix: "antigravity-cli-1.1.10-wsl",
        },
    ],
} as const satisfies SkillRuntimeSpec;

const IDE_SKILL_SPEC = {
    agentRuntimeId: "ANTIGRAVITY_IDE",
    profilePrefix: "antigravity-ide",
    capabilityPrefix: "antigravity.ide",
    outputPrefix: "ANTIGRAVITY_IDE",
    globalTargetContextSchemaId: "ANTIGRAVITY_IDE_GLOBAL_TARGET_V1",
    buildCompatibility: ANTIGRAVITY_IDE_TARGET_BUILD_COMPATIBILITY,
    projectFixtureName: "oaam-phase55-ide-skill-graph",
    globalFixtureName: "oaam-phase55-ide-global-skill",
    projectLoadMarker: "OAAM_PHASE55_IDE_PROJECT_FOLDER_SKILL",
    globalLoadMarker: "OAAM_PHASE55_IDE_GLOBAL_FOLDER_SKILL",
    verifiedBuilds: [
        {
            versionText: "1.107.0",
            buildIdentity: "sha256:56987be1a655ae5903bc47963a67e147d8ee3c36e41144b03210cc9c3e57336f",
            platform: "wsl",
            fixturePrefix: "antigravity-ide-2.1.1-wsl",
        },
        {
            versionText: "1.107.0",
            buildIdentity: "sha256:dca2f8dc41186aff715298830fa3a10cb310e632cb51bb76dac30c2c2fbe37a2",
            platform: "win32",
            fixturePrefix: "antigravity-ide-2.1.1-win32",
        },
    ],
} as const satisfies SkillRuntimeSpec;

const APP_SKILL_SPEC = {
    agentRuntimeId: "ANTIGRAVITY_APP",
    profilePrefix: "antigravity-app",
    capabilityPrefix: "antigravity.app",
    outputPrefix: "ANTIGRAVITY_APP",
    globalTargetContextSchemaId: "ANTIGRAVITY_APP_GLOBAL_TARGET_V1",
    buildCompatibility: ANTIGRAVITY_APP_TARGET_BUILD_COMPATIBILITY,
    projectFixtureName: "oaam-phase55-app-skill-graph",
    globalFixtureName: "oaam-phase55-app-global-skill",
    projectLoadMarker: "OAAM_PHASE55_APP_PROJECT_FOLDER_SKILL",
    globalLoadMarker: "OAAM_PHASE55_APP_GLOBAL_FOLDER_SKILL",
    verifiedBuilds: [
        {
            versionText: "2.2.1",
            buildIdentity: "sha256:b0d127772d2983a93771055a93b673d5fdd1726d6e47db8e269b204e665972d6",
            platform: "wsl",
            fixturePrefix: "antigravity-app-2.2.1-wsl",
        },
        {
            versionText: "2.4.3",
            buildIdentity: "sha256:4dbd1be0a6ebe48ebd370babf9b7d046630b8eac7bb69fbb0469db1aea12bcf8",
            platform: "win32",
            fixturePrefix: "antigravity-app-2.4.3-win32",
        },
    ],
} as const satisfies SkillRuntimeSpec;

export const ANTIGRAVITY_SKILL_TARGET_COMPONENTS = {
    projectFolder: component("antigravity.project-skill-directory-graph-v1"),
    globalFolder: component("antigravity.global-skill-directory-graph-v1"),
    folderReverse: component(`${ANTIGRAVITY_NATIVE_DIALECTS.skillFolder}.native-to-canonical-parser`),
    flatReverse: component(`${ANTIGRAVITY_NATIVE_DIALECTS.skillFlat}.native-to-canonical-parser`),
    rebase: component("antigravity.skill-parent-native-rebase-v1"),
    canonical: component("antigravity.skill-reviewed-canonical-materialization-v1"),
} as const;

export function createAntigravitySkillTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
}): AntigravitySkillTargetSupports {
    return createSkillTargetSupports(CLI_SKILL_SPEC, input);
}

export function createAntigravityIdeSkillTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
}): AntigravitySkillTargetSupports {
    return createSkillTargetSupports(IDE_SKILL_SPEC, input);
}

export function createAntigravityAppSkillTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
}): AntigravitySkillTargetSupports {
    return createSkillTargetSupports(APP_SKILL_SPEC, input);
}

function createSkillTargetSupports(
    spec: SkillRuntimeSpec,
    input: {
        adapterVersion: string;
        agentRuntimes: readonly AgentRuntimeDescriptor[];
        projectTargetContextSchemaId: string;
    },
): AntigravitySkillTargetSupports {
    const projectFolderProfile = `${spec.profilePrefix}-project-skill-directory-v1`;
    const globalFolderProfile = `${spec.profilePrefix}-global-skill-directory-v1`;
    const projectFolderPaths = [
        `.agents/skills/${spec.projectFixtureName}/SKILL.md`,
        `.agents/skills/${spec.projectFixtureName}/assets/marker.bin`,
        `.agents/skills/${spec.projectFixtureName}/references/marker.txt`,
        `.agents/skills/${spec.projectFixtureName}/scripts/marker.py`,
    ] as PosixRelativePath[];
    const globalFolderPaths = [
        `config/skills/${spec.globalFixtureName}/SKILL.md`,
        `config/skills/${spec.globalFixtureName}/references/marker.txt`,
    ] as PosixRelativePath[];
    const canonicalDeclaration = {
        materializer: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.canonical,
        degradationKinds: [...CANONICAL_DEGRADATIONS] as [
            "permission_or_tool_boundary_lost",
            "runtime_specific_metadata_lost",
            "trigger_or_loading_level_lost",
        ],
        reasonCode: "antigravity_skill_reviewed_canonical_conversion",
    };
    const projectFolderBuilds = spec.verifiedBuilds.map((build) =>
        createVerifiedNativeProjectExactGraphBuild({
            agentRuntimeId: spec.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: projectFolderProfile,
            fixtureId: `${build.fixturePrefix}-project-folder-skill-graph-2026-08-07`,
            assetKind: "Skill",
            nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.skillFolder,
            projectGraphValidator: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.projectFolder,
            reverseParser: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.folderReverse,
            rebaseMaterializer: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: canonicalDeclaration,
            restorationDialectIds: [],
            parentRebaseFixtureId: `${build.fixturePrefix}-project-folder-skill-parent-rebase-v1`,
            targetGraphIdentity: projectFolderPaths[0] as PosixRelativePath,
            targetRelativePaths: projectFolderPaths,
            exactLoadMarker: spec.projectLoadMarker,
            reverseFixtureId: `${build.fixturePrefix}-project-folder-skill-reverse-v1`,
        }),
    );
    const globalFolderBuilds = spec.verifiedBuilds.map((build) =>
        createVerifiedNativeGlobalExactGraphBuild({
            agentRuntimeId: spec.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: globalFolderProfile,
            fixtureId: `${build.fixturePrefix}-global-config-folder-skill-graph-2026-08-07`,
            assetKind: "Skill",
            nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.skillFolder,
            globalGraphValidator: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.globalFolder,
            reverseParser: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.folderReverse,
            rebaseMaterializer: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: canonicalDeclaration,
            restorationDialectIds: [],
            parentRebaseFixtureId: `${build.fixturePrefix}-global-folder-skill-parent-rebase-v1`,
            targetGraphIdentity: globalFolderPaths[0] as PosixRelativePath,
            targetRelativePaths: globalFolderPaths,
            exactLoadMarker: spec.globalLoadMarker,
            reverseFixtureId: `${build.fixturePrefix}-global-folder-skill-reverse-v1`,
        }),
    );
    const common = {
        adapterId: "ANTIGRAVITY" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: "Skill" as const,
        rebaseMaterializer: ANTIGRAVITY_SKILL_REBASE_MATERIALIZER,
        restorationDialectIds: [],
        buildCompatibility: spec.buildCompatibility,
    };
    return {
        projectFolder: createNativeProjectExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_NATIVE_PROJECT_SKILL_DIRECTORY_V1`,
            materializationProfileId: projectFolderProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-project-skill-directory-v1`,
            nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.skillFolder,
            reverseParser: {
                ref: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.folderReverse,
                parse: parseChangedAntigravitySkillFile,
            },
            projectGraphValidator: {
                ref: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.projectFolder,
                project: projectAntigravityFolderSkillGraph,
            },
            canonicalMaterializer: ANTIGRAVITY_SKILL_CANONICAL_MATERIALIZER,
            target: { targetContextSchemaId: input.projectTargetContextSchemaId, requiredFacts: PROJECT_TARGET_FACTS },
            verifiedBuilds: projectFolderBuilds,
        }),
        globalFolder: createNativeGlobalExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_NATIVE_GLOBAL_SKILL_DIRECTORY_V1`,
            materializationProfileId: globalFolderProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-global-skill-directory-v1`,
            nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.skillFolder,
            reverseParser: {
                ref: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.folderReverse,
                parse: parseChangedAntigravitySkillFile,
            },
            globalGraphValidator: {
                ref: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.globalFolder,
                validate: projectAntigravityGlobalFolderSkillGraph,
            },
            canonicalMaterializer: ANTIGRAVITY_SKILL_CANONICAL_MATERIALIZER,
            target: { targetContextSchemaId: spec.globalTargetContextSchemaId, requiredFacts: {} },
            verifiedBuilds: globalFolderBuilds,
        }),
    };
}

export async function analyzeAntigravitySkillTargets(
    input: RenderAnalysisInput,
    supports: AntigravitySkillTargetSupports,
): Promise<AdapterRenderAnalysisResult> {
    const support = selectAntigravitySkillTargetSupport(input, supports);
    if (support !== null) return support.analyze(input);
    const issue = diagnostic(
        "render",
        "antigravity_skill_target_shape_ambiguous",
        "One Antigravity Skill Deployment must use one exact Project or Global scope and one supported native shape",
        "conflict",
        "error",
    );
    return {
        status: "failed",
        outputUnits: [],
        semanticOptions: [],
        blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: issue.code,
            diagnostics: [issue],
        })),
        diagnostics: [issue],
    };
}

export function selectAntigravitySkillTargetSupport(
    input: RenderAnalysisInput,
    supports: AntigravitySkillTargetSupports,
): NativeProjectExactGraphProviderSupport | NativeGlobalExactGraphProviderSupport | null {
    const scopes = new Set(input.deployment.assets.map((asset) => asset.scope));
    const nativeDialects = new Set(
        input.dialectInputs.flatMap((group) =>
            group.inputs.flatMap((item) =>
                item.inputKind === "native_representation"
                    ? [item.representation.dialectId]
                    : item.inputKind === "canonical_materialization"
                      ? [item.nativeDialectId]
                      : [],
            ),
        ),
    );
    if (scopes.size === 1 && scopes.has("global") && nativeDialects.size === 1) {
        return nativeDialects.has(ANTIGRAVITY_NATIVE_DIALECTS.skillFolder) ? supports.globalFolder : null;
    }
    if (scopes.size === 1 && scopes.has("project") && nativeDialects.size === 1) {
        const dialect = [...nativeDialects][0];
        if (dialect === ANTIGRAVITY_NATIVE_DIALECTS.skillFolder) return supports.projectFolder;
    }
    return null;
}

export const ANTIGRAVITY_SKILL_REBASE_MATERIALIZER: NativeProjectExactGraphRebaseMaterializer = {
    ref: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.rebase,
    materialize: materializeAntigravitySkillParentGraph,
};

const ANTIGRAVITY_SKILL_CANONICAL_MATERIALIZER: NativeProjectExactGraphCanonicalMaterializer = {
    ref: ANTIGRAVITY_SKILL_TARGET_COMPONENTS.canonical,
    degradationKinds: [...CANONICAL_DEGRADATIONS],
    reasonCode: "antigravity_skill_reviewed_canonical_conversion",
    diagnosticMessage:
        "OAAM can write the portable Skill graph, but source-runtime loading, permission and private metadata do not have Antigravity equivalents",
    materialize: materializeCanonicalAntigravitySkill,
    validateEntry: validateCanonicalAntigravitySkillEntry,
};

function projectAntigravityFolderSkillGraph(files: readonly RenderNativeRepresentationFileInput[]) {
    return projectAntigravitySkillFolderGraph(files, "project");
}

function projectAntigravityGlobalFolderSkillGraph(files: readonly RenderNativeRepresentationFileInput[]) {
    return projectAntigravitySkillFolderGraph(files, "global");
}

function projectAntigravitySkillFolderGraph(files: readonly RenderNativeRepresentationFileInput[], scope: "project" | "global") {
    if (files.length === 0) return null;
    const paths = files.map((file) => file.relativePath);
    if (new Set(paths).size !== paths.length) return null;
    const entries = paths.filter((relativePath) => relativePath.endsWith(`/${ENTRY_NAME}`));
    if (entries.length !== 1) return null;
    const entryPath = entries[0] as PosixRelativePath;
    const boundary = entryPath.slice(0, -(ENTRY_NAME.length + 1));
    if (!isAntigravitySkillBoundary(boundary, scope) || paths.some((path) => !isStrictDescendant(path, boundary))) {
        return null;
    }
    return {
        graphIdentityRelativePath: entryPath,
        files: paths.map((nativeRelativePath) => ({
            nativeRelativePath,
            canonicalLogicalPath: nativeRelativePath.slice(boundary.length + 1) as PosixRelativePath,
        })),
        managedDirectoryBoundaries: [boundary as PosixRelativePath],
    };
}

function projectAntigravityFlatSkillGraph(files: readonly RenderNativeRepresentationFileInput[]) {
    if (files.length !== 1) return null;
    const file = files[0];
    if (file === undefined || !isAntigravityProjectFlatSkillPath(file.relativePath)) return null;
    return {
        graphIdentityRelativePath: file.relativePath,
        files: [{ nativeRelativePath: file.relativePath, canonicalLogicalPath: ENTRY_NAME as PosixRelativePath }],
        managedDirectoryBoundaries: [],
    };
}

function materializeAntigravitySkillParentGraph(
    input: NativeProjectExactGraphRebaseInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (input.assetKind !== "Skill" || input.targetCanonical.kind !== "Skill" || input.restorationInputs.length !== 0) {
        return null;
    }
    const projection =
        input.nativeDialectId === ANTIGRAVITY_NATIVE_DIALECTS.skillFolder
            ? [
                  projectAntigravitySkillFolderGraph(input.parent.files, "project"),
                  projectAntigravitySkillFolderGraph(input.parent.files, "global"),
              ].find((candidate) => candidate !== null)
            : input.nativeDialectId === ANTIGRAVITY_NATIVE_DIALECTS.skillFlat
              ? projectAntigravityFlatSkillGraph(input.parent.files)
              : null;
    if (projection === null || projection === undefined || projection.files.length !== input.targetFiles.length) return null;
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

function materializeCanonicalAntigravitySkill(
    input: NativeProjectExactGraphCanonicalMaterializationInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    const canonical = input.targetCanonical;
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== ANTIGRAVITY_NATIVE_DIALECTS.skillFolder ||
        canonical.kind !== "Skill" ||
        input.restorationInputs.length !== 0 ||
        !isPortableSkillTypeData(canonical.typeData)
    ) {
        return null;
    }
    const entry = input.targetFiles.filter((file) => file.file.role === "entry");
    if (entry.length !== 1 || entry[0]?.file.logicalPath !== ENTRY_NAME || entry[0].contentKind !== "text") return null;
    const logicalPaths = input.targetFiles.map((file) => file.file.logicalPath);
    if (new Set(logicalPaths).size !== logicalPaths.length || logicalPaths.some((value) => !isCanonicalRelativePath(value))) {
        return null;
    }
    const boundary =
        input.targetScope === "project"
            ? `.agents/skills/oaam-skill-${input.targetVersion.assetId.slice(0, 8)}`
            : `config/skills/oaam-skill-${input.targetVersion.assetId.slice(0, 8)}`;
    const nativeFiles = input.targetFiles.map((file) => {
        const relativePath = `${boundary}/${file.file.logicalPath}` as PosixRelativePath;
        if (file.file.role === "entry" && file.contentKind === "text") {
            return textNativeFile(
                relativePath,
                `${serializeSkillFrontmatter(canonical.typeData)}${file.text}`,
                file.file.mediaType,
                file.file.executable,
            );
        }
        return file.contentKind === "text"
            ? textNativeFile(relativePath, file.text, file.file.mediaType, file.file.executable)
            : binaryNativeFile(relativePath, file.bytes, file.file.mediaType, file.file.executable);
    });
    nativeFiles.sort((left, right) => compareText(left.relativePath, right.relativePath));
    return { nativeFiles };
}

function parseChangedAntigravitySkillFile(input: {
    assetKind: "Skill";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}) {
    if (
        input.assetKind !== "Skill" ||
        (input.nativeDialectId !== ANTIGRAVITY_NATIVE_DIALECTS.skillFolder &&
            input.nativeDialectId !== ANTIGRAVITY_NATIVE_DIALECTS.skillFlat) ||
        input.appliedContent.contentKind !== input.currentContent.contentKind
    ) {
        return null;
    }
    if (input.relativePath.endsWith(`/${ENTRY_NAME}`) || isAntigravityProjectFlatSkillPath(input.relativePath)) {
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
    const parsed = parseAntigravityFrontmatter(nativeText);
    if (!parsed.hasFrontmatter || !parsed.closed || parsed.body.trim() === "" || parsed.diagnostics.length !== 0) return null;
    return { prefix: nativeText.slice(0, nativeText.length - parsed.body.length), body: parsed.body };
}

function isAntigravitySkillBoundary(value: string, scope: "project" | "global"): boolean {
    if (!isCanonicalRelativePath(value)) return false;
    const segments = value.split("/");
    return scope === "project"
        ? segments.length === 3 && (segments[0] === ".agents" || segments[0] === ".agent") && segments[1] === "skills"
        : segments.length === 3 && segments[0] === "config" && segments[1] === "skills";
}

function isAntigravityProjectFlatSkillPath(value: string): boolean {
    if (!isCanonicalRelativePath(value)) return false;
    const segments = value.split("/");
    return (
        segments.length === 3 &&
        segments[0] === ".agents" &&
        segments[1] === "skills" &&
        (segments[2] as string).endsWith(".md") &&
        segments[2] !== ENTRY_NAME
    );
}

function isStrictDescendant(relativePath: string, boundary: string): boolean {
    return isCanonicalRelativePath(relativePath) && relativePath.startsWith(`${boundary}/`);
}

function isCanonicalRelativePath(value: string): value is PosixRelativePath {
    return (
        value !== "" &&
        !value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
    );
}

function validatesRebasedGraph(
    input: NativeProjectExactGraphRebaseInput,
    nativeFiles: RenderNativeRepresentationFileInput[],
): boolean {
    return validateAntigravityNativeDialect({
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

function isPortableSkillTypeData(value: SkillTypeDataV2): boolean {
    return (
        value.schemaVersion === 2 &&
        value.name.trim() !== "" &&
        value.description.trim() !== "" &&
        value.name.length <= 256 &&
        value.description.length <= 4096
    );
}

function validateCanonicalAntigravitySkillEntry(input: CanonicalRenderEntryValidationInput): boolean {
    if (
        input.canonical.kind !== "Skill" ||
        input.nativeDialectId !== ANTIGRAVITY_NATIVE_DIALECTS.skillFolder ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text" ||
        !isPortableSkillTypeData(input.canonical.typeData)
    )
        return false;
    const boundary =
        input.targetScope === "project"
            ? `.agents/skills/oaam-skill-${input.targetVersion.assetId.slice(0, 8)}`
            : `config/skills/oaam-skill-${input.targetVersion.assetId.slice(0, 8)}`;
    if (input.nativeEntry.relativePath !== `${boundary}/${ENTRY_NAME}`) return false;
    const data = input.canonical.typeData;
    const parsed = parseAntigravityFrontmatter(input.nativeEntry.content.text);
    const expected: Record<string, unknown> = { name: data.name, description: data.description };
    if (data.portableMetadata.license !== "") expected.license = data.portableMetadata.license;
    if (data.portableMetadata.compatibility !== "") expected.compatibility = data.portableMetadata.compatibility;
    if (Object.keys(data.portableMetadata.metadata).length > 0) expected.metadata = data.portableMetadata.metadata;
    return (
        parsed.hasFrontmatter &&
        parsed.closed &&
        parsed.diagnostics.length === 0 &&
        parsed.body.trim() !== "" &&
        parsed.body === input.canonicalEntry.text &&
        stableSourceValueEqual(parsed.values, expected)
    );
}

function serializeSkillFrontmatter(typeData: SkillTypeDataV2): string {
    const lines = ["---", `name: ${JSON.stringify(typeData.name)}`, `description: ${JSON.stringify(typeData.description)}`];
    if (typeData.portableMetadata.license !== "") lines.push(`license: ${JSON.stringify(typeData.portableMetadata.license)}`);
    if (typeData.portableMetadata.compatibility !== "") {
        lines.push(`compatibility: ${JSON.stringify(typeData.portableMetadata.compatibility)}`);
    }
    const metadata = Object.entries(typeData.portableMetadata.metadata).sort(([left], [right]) => compareText(left, right));
    if (metadata.length > 0) {
        lines.push("metadata:", ...metadata.map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`));
    }
    return `${lines.join("\n")}\n---\n`;
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
