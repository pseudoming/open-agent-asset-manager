/** OpenCode CLI/App project, config and shared-root Skill targets over the exact native graph contract. */

import {
    defineDialectComponentV1 as component,
    adapterOperationDiagnostic as diagnostic,
    sha256SourceBytes,
    stableSourceValueEqual,
} from "@oaam/adapter-framework";
import {
    type AdapterRenderAnalysisResult,
    type AgentRuntimeDescriptor,
    type CanonicalRenderEntryValidationInput,
    type CanonicalMaterializationAssessmentInput,
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
    type PosixRelativePath,
    type RenderAnalysisInput,
    type RenderNativeRepresentationFileInput,
    type SkillTypeDataV2,
} from "@oaam/core/adapter-spi";
import { parseOpencodeFrontmatter } from "./opencode-frontmatter";
import { OPENCODE_NATIVE_DIALECTS, opencodeSkillDialect, type OpencodeSkillInterpretation } from "./opencode-source-read-model";
import { validateOpencodeNativeDialect } from "./opencode-source-read-native";
import {
    appendOpencodeBuildCompatibilityWarning,
    OPENCODE_TARGET_BUILD_COMPATIBILITY,
} from "./opencode-target-build-compatibility";
import type { OpencodeTargetBuildAnchor } from "./opencode-target-builds";

const ENTRY_NAME = "SKILL.md";
const PROJECT_FACTS = { "oaam.project-binding": "registered" } as const;
const GLOBAL_FACTS = { "oaam.target-kind": "global" } as const;
const DIRECTORY_FACTS = { "oaam.target-kind": "directory" } as const;
const CANONICAL_DEGRADATIONS = [
    "permission_or_tool_boundary_lost",
    "runtime_specific_metadata_lost",
    "trigger_or_loading_level_lost",
] as const;

const CANONICAL_SOURCE_DIALECTS = [
    "antigravity-skill-flat-v1",
    "antigravity-skill-folder-v1",
    "claudecode-skill-directory-v1",
    "codex-skill-directory-v1",
    "cursor-skill-directory-v1",
    "opencode-skill-directory-v1",
    "opencode-skill-directory-v2",
    "zcode-skill-directory-v1",
];
const EXPRESSIBLE_SOURCE_FIELDS: Readonly<Record<string, readonly string[]>> = {
    "claudecode-skill-directory-v1": [
        "when_to_use",
        "allowed-tools",
        "disallowed-tools",
        "argument-hint",
        "arguments",
        "model",
        "effort",
        "disable-model-invocation",
        "user-invocable",
        "context",
        "agent",
        "paths",
    ],
    "cursor-skill-directory-v1": ["disable-model-invocation"],
    "opencode-skill-directory-v1": ["slash"],
    "opencode-skill-directory-v2": ["slash"],
};

export interface OpencodeSkillTargetSupports {
    projectFolder: NativeProjectExactGraphProviderSupport;
    globalConfigFolder: NativeGlobalExactGraphProviderSupport;
    sharedDirectoryFolder: NativeGlobalExactGraphProviderSupport;
}

interface SupportFactoryInput {
    adapterVersion: string;
    /** Fix historical inspectors to v1 while the current CLI uses v2. */
    skillInterpretation?: OpencodeSkillInterpretation;
    requiresNativeSourceAssessment?: boolean;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    agentRuntimeId: "OPENCODE_CLI" | "OPENCODE_APP";
    runtimeSlug: "cli" | "app";
    targetBuilds: readonly OpencodeTargetBuildAnchor[];
    projectTargetBuilds?: readonly OpencodeTargetBuildAnchor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
    sharedDirectoryTargetContextSchemaId: string;
}

interface SkillVariantSpec {
    interpretation?: OpencodeSkillInterpretation;
    requiresNativeSourceAssessment?: boolean;
    key: keyof OpencodeSkillTargetSupports;
    scope: "project" | "global";
    targetKind: "project" | "global" | "directory";
    targetBoundary: PosixRelativePath;
    graphComponent: (typeof OPENCODE_SKILL_TARGET_COMPONENTS)["projectFolder" | "globalConfigFolder" | "sharedDirectoryFolder"];
    canonicalComponent: (typeof OPENCODE_SKILL_TARGET_COMPONENTS)[
        | "projectCanonical"
        | "globalConfigCanonical"
        | "sharedDirectoryCanonical"];
    outputSuffix: string;
    profileSuffix: string;
    fixtureSlug: string;
    loadMarkerSuffix: string;
}

export const OPENCODE_SKILL_TARGET_COMPONENTS = {
    projectFolder: component("opencode.project-skill-directory-graph-v1"),
    globalConfigFolder: component("opencode.global-config-skill-directory-graph-v1"),
    sharedDirectoryFolder: component("opencode.shared-skill-directory-graph-v1"),
    reverse: component(`${OPENCODE_NATIVE_DIALECTS.skill}.native-to-canonical-parser`),
    rebase: component("opencode.skill-directory-parent-rebase-v1"),
    projectCanonical: component("opencode.project-skill-reviewed-canonical-materialization-v1"),
    globalConfigCanonical: component("opencode.global-config-skill-reviewed-canonical-materialization-v1"),
    sharedDirectoryCanonical: component("opencode.shared-skill-reviewed-canonical-materialization-v1"),
} as const;

export const OPENCODE_CLI_SKILL_TARGET_COMPONENTS = Object.fromEntries(
    Object.entries(OPENCODE_SKILL_TARGET_COMPONENTS).map(([key, ref]) => [
        key,
        component(ref.componentId.replace("-v1.", "-v2.").replace(/-v1$/u, "-v2")),
    ]),
) as typeof OPENCODE_SKILL_TARGET_COMPONENTS;

const VARIANTS: readonly SkillVariantSpec[] = [
    {
        key: "projectFolder",
        scope: "project",
        targetKind: "project",
        targetBoundary: ".opencode/skills/oaam-phase57-skill-graph" as PosixRelativePath,
        graphComponent: OPENCODE_SKILL_TARGET_COMPONENTS.projectFolder,
        canonicalComponent: OPENCODE_SKILL_TARGET_COMPONENTS.projectCanonical,
        outputSuffix: "NATIVE_PROJECT_SKILL_DIRECTORY_V1",
        profileSuffix: "project-skill-directory-v1",
        fixtureSlug: "project-skill-directory",
        loadMarkerSuffix: "PROJECT_SKILL_GRAPH",
    },
    {
        key: "globalConfigFolder",
        scope: "global",
        targetKind: "global",
        targetBoundary: "skills/oaam-phase57-global-skill-graph" as PosixRelativePath,
        graphComponent: OPENCODE_SKILL_TARGET_COMPONENTS.globalConfigFolder,
        canonicalComponent: OPENCODE_SKILL_TARGET_COMPONENTS.globalConfigCanonical,
        outputSuffix: "NATIVE_GLOBAL_CONFIG_SKILL_DIRECTORY_V1",
        profileSuffix: "global-config-skill-directory-v1",
        fixtureSlug: "global-config-skill-directory",
        loadMarkerSuffix: "GLOBAL_CONFIG_SKILL_GRAPH",
    },
    {
        key: "sharedDirectoryFolder",
        scope: "global",
        targetKind: "directory",
        targetBoundary: "oaam-phase57-shared-skill-graph" as PosixRelativePath,
        graphComponent: OPENCODE_SKILL_TARGET_COMPONENTS.sharedDirectoryFolder,
        canonicalComponent: OPENCODE_SKILL_TARGET_COMPONENTS.sharedDirectoryCanonical,
        outputSuffix: "NATIVE_SHARED_SKILL_DIRECTORY_V1",
        profileSuffix: "shared-skill-directory-v1",
        fixtureSlug: "shared-skill-directory",
        loadMarkerSuffix: "SHARED_SKILL_GRAPH",
    },
];

export function createOpencodeSkillTargetSupports(input: SupportFactoryInput): OpencodeSkillTargetSupports {
    const interpretation = input.skillInterpretation ?? (input.agentRuntimeId === "OPENCODE_CLI" ? 2 : 1);
    if (interpretation === 2 && input.agentRuntimeId !== "OPENCODE_CLI") throw new Error("CLI Skill v2 is not App authority");
    const variants = VARIANTS.map((spec) =>
        interpretation === 1
            ? spec
            : {
                  ...spec,
                  interpretation,
                  requiresNativeSourceAssessment: input.requiresNativeSourceAssessment !== false,
                  graphComponent: OPENCODE_CLI_SKILL_TARGET_COMPONENTS[spec.key],
                  canonicalComponent:
                      spec.key === "projectFolder"
                          ? OPENCODE_CLI_SKILL_TARGET_COMPONENTS.projectCanonical
                          : spec.key === "globalConfigFolder"
                            ? OPENCODE_CLI_SKILL_TARGET_COMPONENTS.globalConfigCanonical
                            : OPENCODE_CLI_SKILL_TARGET_COMPONENTS.sharedDirectoryCanonical,
                  outputSuffix: spec.outputSuffix.replace(/_V1$/u, "_V2"),
                  profileSuffix: spec.profileSuffix.replace(/-v1$/u, "-v2"),
                  fixtureSlug: `${spec.fixtureSlug}-interpretation-v2`,
              },
    );
    return Object.fromEntries(
        variants.map((spec) => [
            spec.key,
            createVariantSupport(
                {
                    ...spec,
                    canonicalComponent:
                        interpretation === 2 && input.requiresNativeSourceAssessment !== false
                            ? component(spec.canonicalComponent.componentId.replace(/-v2$/u, "-v3"))
                            : spec.canonicalComponent,
                },
                input,
            ),
        ]),
    ) as unknown as OpencodeSkillTargetSupports;
}

function createVariantSupport(
    spec: SkillVariantSpec,
    input: SupportFactoryInput,
): NativeProjectExactGraphProviderSupport | NativeGlobalExactGraphProviderSupport {
    const interpretation = spec.interpretation ?? 1;
    const nativeDialectId = opencodeSkillDialect(interpretation);
    const components = interpretation === 2 ? OPENCODE_CLI_SKILL_TARGET_COMPONENTS : OPENCODE_SKILL_TARGET_COMPONENTS;
    const rebaseMaterializer = interpretation === 2 ? OPENCODE_CLI_SKILL_REBASE_MATERIALIZER : OPENCODE_SKILL_REBASE_MATERIALIZER;
    const preservation =
        interpretation === 2
            ? spec.requiresNativeSourceAssessment === true
                ? { preservationDialectIds: [...CANONICAL_SOURCE_DIALECTS], requiresNativeSourceAssessment: true as const }
                : { preservationDialectIds: [OPENCODE_NATIVE_DIALECTS.skill] }
            : {};
    const fixturePaths = [
        `${spec.targetBoundary}/SKILL.md`,
        `${spec.targetBoundary}/assets/marker.bin`,
        `${spec.targetBoundary}/references/details.md`,
        `${spec.targetBoundary}/scripts/marker.py`,
    ] as PosixRelativePath[];
    const canonicalDeclaration = {
        materializer: spec.canonicalComponent,
        ...preservation,
        ...(interpretation === 2 ? { assessesLoss: true as const } : {}),
        degradationKinds: [...CANONICAL_DEGRADATIONS] as [
            "permission_or_tool_boundary_lost",
            "runtime_specific_metadata_lost",
            "trigger_or_loading_level_lost",
        ],
        reasonCode: "opencode_skill_reviewed_canonical_conversion",
    };
    const targetBuilds = spec.key === "projectFolder" ? (input.projectTargetBuilds ?? input.targetBuilds) : input.targetBuilds;
    const verifiedBuilds = targetBuilds.map((build) => {
        const commonBuild = {
            agentRuntimeId: input.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: `opencode-${input.runtimeSlug}-${spec.profileSuffix}`,
            fixtureId: `opencode-${input.runtimeSlug}-${build.versionText}-${build.platform}-${spec.fixtureSlug}-${build.fixtureDate}`,
            assetKind: "Skill" as const,
            nativeDialectId,
            reverseParser: components.reverse,
            rebaseMaterializer: components.rebase,
            canonicalMaterialization: canonicalDeclaration,
            restorationDialectIds: [],
            parentRebaseFixtureId: `opencode-${input.runtimeSlug}-${build.platform}-${spec.fixtureSlug}-parent-rebase-v1`,
            targetGraphIdentity: fixturePaths[0] as PosixRelativePath,
            targetRelativePaths: fixturePaths,
            exactLoadMarker: build.exactLoadMarker ?? `OAAM_OPENCODE_${input.runtimeSlug.toUpperCase()}_${spec.loadMarkerSuffix}`,
            reverseFixtureId: `opencode-${input.runtimeSlug}-${build.platform}-${spec.fixtureSlug}-reverse-v1`,
        };
        return spec.scope === "project"
            ? createVerifiedNativeProjectExactGraphBuild({
                  ...commonBuild,
                  projectGraphValidator: spec.graphComponent,
              })
            : createVerifiedNativeGlobalExactGraphBuild({
                  ...commonBuild,
                  globalGraphValidator: spec.graphComponent,
              });
    });
    const canonicalMaterializer: NativeProjectExactGraphCanonicalMaterializer = {
        ref: spec.canonicalComponent,
        ...preservation,
        degradationKinds: [...CANONICAL_DEGRADATIONS],
        reasonCode: "opencode_skill_reviewed_canonical_conversion",
        diagnosticMessage:
            spec.requiresNativeSourceAssessment === true
                ? "OpenCode receives the portable Skill graph; the review identifies source metadata or command exposure that this target does not retain"
                : interpretation === 2
                  ? "OpenCode CLI makes this Skill directly invocable as a command; its saved invocation restriction is not retained"
                  : "OAAM can preserve the portable Skill graph, but source-runtime policy and trigger metadata do not have proven OpenCode equivalents",
        ...(interpretation === 2
            ? {
                  assessLoss: (assessmentInput: CanonicalMaterializationAssessmentInput) =>
                      assessCanonicalOpencodeSkillLoss(assessmentInput, spec),
              }
            : {}),
        materialize: (materializationInput) => materializeCanonicalOpencodeSkill(materializationInput, spec),
        validateEntry: (validationInput) => validateCanonicalOpencodeSkillEntry(validationInput, spec),
    };
    const common = {
        adapterId: "OPENCODE" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: input.agentRuntimeId,
        assetKind: "Skill" as const,
        outputContractId: `OPENCODE_${input.runtimeSlug.toUpperCase()}_${spec.outputSuffix}`,
        materializationProfileId: `opencode-${input.runtimeSlug}-${spec.profileSuffix}`,
        materializerCapabilityKey: `opencode.${input.runtimeSlug}-${spec.profileSuffix}`,
        nativeDialectId,
        reverseParser: {
            ref: components.reverse,
            parse: (input: Parameters<typeof parseChangedOpencodeSkillFile>[0]) =>
                parseChangedOpencodeSkillFile(input, nativeDialectId),
        },
        rebaseMaterializer,
        canonicalMaterializer,
        restorationDialectIds: [],
        buildCompatibility: OPENCODE_TARGET_BUILD_COMPATIBILITY,
    };
    const validate = (files: readonly RenderNativeRepresentationFileInput[]) => projectOpencodeSkillGraph(files, spec);
    if (spec.scope === "project") {
        return createNativeProjectExactGraphProviderSupport({
            ...common,
            projectGraphValidator: { ref: spec.graphComponent, project: validate },
            target: { targetContextSchemaId: input.projectTargetContextSchemaId, requiredFacts: PROJECT_FACTS },
            verifiedBuilds: verifiedBuilds as ReturnType<typeof createVerifiedNativeProjectExactGraphBuild>[],
        });
    }
    return createNativeGlobalExactGraphProviderSupport({
        ...common,
        globalGraphValidator: { ref: spec.graphComponent, validate },
        target: {
            targetContextSchemaId:
                spec.targetKind === "global" ? input.globalTargetContextSchemaId : input.sharedDirectoryTargetContextSchemaId,
            requiredFacts: spec.targetKind === "global" ? GLOBAL_FACTS : DIRECTORY_FACTS,
        },
        verifiedBuilds: verifiedBuilds as ReturnType<typeof createVerifiedNativeGlobalExactGraphBuild>[],
    });
}

export async function analyzeOpencodeSkillTargets(
    input: RenderAnalysisInput,
    supports: OpencodeSkillTargetSupports,
): Promise<AdapterRenderAnalysisResult> {
    const scopes = new Set(input.deployment.assets.map((asset) => asset.scope));
    const contextIds = new Set(input.deployment.targetContexts.map((context) => context.targetContextSchemaId));
    const matching = VARIANTS.filter(
        (spec) =>
            scopes.size === 1 &&
            scopes.has(spec.scope) &&
            contextIds.has(supports[spec.key].targetContextSchema.targetContextSchemaId),
    );
    const match = matching.length === 1 ? matching[0] : undefined;
    if (match !== undefined) {
        const support = supports[match.key];
        return appendOpencodeBuildCompatibilityWarning(await support.analyze(input), input, support.renderContractDeclaration);
    }
    const issue = diagnostic(
        "render",
        "opencode_skill_target_shape_ambiguous",
        "One OpenCode Skill Deployment must use one exact Project, global config or shared Skill-directory target",
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

export const OPENCODE_SKILL_REBASE_MATERIALIZER: NativeProjectExactGraphRebaseMaterializer = {
    ref: OPENCODE_SKILL_TARGET_COMPONENTS.rebase,
    materialize: (input) => materializeOpencodeSkillParentGraph(input, OPENCODE_NATIVE_DIALECTS.skill),
};

export const OPENCODE_CLI_SKILL_REBASE_MATERIALIZER: NativeProjectExactGraphRebaseMaterializer = {
    ref: OPENCODE_CLI_SKILL_TARGET_COMPONENTS.rebase,
    materialize: (input) => materializeOpencodeSkillParentGraph(input, OPENCODE_NATIVE_DIALECTS.skillCli),
};

function projectOpencodeSkillGraph(files: readonly RenderNativeRepresentationFileInput[], spec: SkillVariantSpec) {
    if (files.length === 0) return null;
    const paths = files.map((file) => file.relativePath);
    if (new Set(paths).size !== paths.length) return null;
    const entries = paths.filter((relativePath) => relativePath.endsWith(`/${ENTRY_NAME}`));
    if (entries.length !== 1) return null;
    const entryPath = entries[0] as PosixRelativePath;
    const boundary = entryPath.slice(0, -(ENTRY_NAME.length + 1));
    if (!isOpencodeSkillBoundary(boundary, spec) || paths.some((path) => !isStrictDescendant(path, boundary))) return null;
    return {
        graphIdentityRelativePath: entryPath,
        files: paths.map((nativeRelativePath) => ({
            nativeRelativePath,
            canonicalLogicalPath: nativeRelativePath.slice(boundary.length + 1) as PosixRelativePath,
        })),
        managedDirectoryBoundaries: [boundary as PosixRelativePath],
    };
}

function materializeOpencodeSkillParentGraph(
    input: NativeProjectExactGraphRebaseInput,
    expectedNativeDialectId: string,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== expectedNativeDialectId ||
        input.targetCanonical.kind !== "Skill" ||
        input.restorationInputs.length !== 0
    ) {
        return null;
    }
    const projections = VARIANTS.map((spec) => projectOpencodeSkillGraph(input.parent.files, spec)).filter(
        (projection) => projection !== null,
    );
    if (projections.length !== 1) return null;
    const projection = projections[0];
    if (projection === undefined || projection.files.length !== input.targetFiles.length) return null;
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
                textNativeFile(relativePath, `${split.prefix}${target.text}`, target.file.mediaType, parent.executable),
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

function materializeCanonicalOpencodeSkill(
    input: NativeProjectExactGraphCanonicalMaterializationInput,
    spec: SkillVariantSpec,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    const canonical = input.targetCanonical;
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== opencodeSkillDialect(spec.interpretation ?? 1) ||
        canonical.kind !== "Skill" ||
        input.targetScope !== spec.scope ||
        input.restorationInputs.length !== 0 ||
        !isPortableOpencodeSkill(canonical.typeData)
    ) {
        return null;
    }
    const entries = input.targetFiles.filter((file) => file.file.role === "entry");
    if (entries.length !== 1 || entries[0]?.file.logicalPath !== ENTRY_NAME || entries[0].contentKind !== "text") return null;
    if (
        spec.requiresNativeSourceAssessment === true &&
        assessCanonicalOpencodeSkillLoss(
            {
                canonical,
                canonicalEntry: { contentKind: "text", text: entries[0].text },
                targetVersion: input.targetVersion,
                targetScope: input.targetScope,
                nativeDialectId: input.nativeDialectId,
                nativePreservationSeed: input.nativePreservationSeed,
            },
            spec,
        ) === null
    )
        return null;
    const logicalPaths = input.targetFiles.map((file) => file.file.logicalPath);
    if (new Set(logicalPaths).size !== logicalPaths.length || logicalPaths.some((value) => !isCanonicalRelativePath(value))) {
        return null;
    }
    if (
        input.nativePreservationSeed !== undefined &&
        (spec.requiresNativeSourceAssessment !== true ||
            input.nativePreservationSeed.representation.dialectId === OPENCODE_NATIVE_DIALECTS.skill)
    )
        return materializePreservedOpencodeSkill(input, spec);
    const boundary = replaceFixtureBoundary(spec.targetBoundary, input.targetVersion.assetId.slice(0, 8));
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

function projectPreservedSkillSource(files: readonly RenderNativeRepresentationFileInput[]) {
    const projections = VARIANTS.flatMap((sourceSpec) => {
        const projection = projectOpencodeSkillGraph(files, sourceSpec);
        return projection === null ? [] : [projection];
    });
    return projections.length === 1 ? projections[0]! : null;
}

function preservedSkillTargetBoundary(sourceBoundary: PosixRelativePath, spec: SkillVariantSpec, assetId: string) {
    return isOpencodeSkillBoundary(sourceBoundary, spec)
        ? sourceBoundary
        : replaceFixtureBoundary(spec.targetBoundary, assetId.slice(0, 8));
}

function materializePreservedOpencodeSkill(input: NativeProjectExactGraphCanonicalMaterializationInput, spec: SkillVariantSpec) {
    const seed = input.nativePreservationSeed;
    if (spec.interpretation !== 2 || seed?.representation.dialectId !== OPENCODE_NATIVE_DIALECTS.skill) return null;
    const projection = projectPreservedSkillSource(seed.files);
    if (projection === null || projection.files.length !== input.targetFiles.length) return null;
    const boundary = preservedSkillTargetBoundary(projection.managedDirectoryBoundaries[0]!, spec, input.targetVersion.assetId);
    const nativeByPath = new Map(seed.files.map((file) => [file.relativePath, file]));
    const nativeFiles: RenderNativeRepresentationFileInput[] = [];
    for (const target of input.targetFiles) {
        const sourcePath = projection.files.find(
            (file) => file.canonicalLogicalPath === target.file.logicalPath,
        )?.nativeRelativePath;
        const source = sourcePath === undefined ? undefined : nativeByPath.get(sourcePath);
        if (source === undefined || source.contentKind !== target.contentKind) return null;
        const path = `${boundary}/${target.file.logicalPath}`;
        if (target.file.role === "entry") {
            if (source.contentKind !== "text" || target.contentKind !== "text") return null;
            const split = splitSkillDocument(source.text);
            if (split === null) return null;
            nativeFiles.push(textNativeFile(path, split.prefix + target.text, target.file.mediaType, target.file.executable));
        } else
            nativeFiles.push(
                target.contentKind === "text"
                    ? textNativeFile(path, target.text, target.file.mediaType, target.file.executable)
                    : binaryNativeFile(path, target.bytes, target.file.mediaType, target.file.executable),
            );
    }
    return { nativeFiles: nativeFiles.sort((a, b) => compareText(a.relativePath, b.relativePath)) };
}

function validatePreservedOpencodeSkillEntry(input: CanonicalRenderEntryValidationInput, spec: SkillVariantSpec): boolean {
    const seed = input.nativePreservationSeed;
    if (
        spec.interpretation !== 2 ||
        seed?.representation.dialectId !== OPENCODE_NATIVE_DIALECTS.skill ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text"
    )
        return false;
    const projection = projectPreservedSkillSource(seed.files);
    if (projection === null) return false;
    const boundary = preservedSkillTargetBoundary(projection.managedDirectoryBoundaries[0]!, spec, input.targetVersion.assetId);
    const source = seed.files.find((file) => file.relativePath === projection.graphIdentityRelativePath);
    if (input.nativeEntry.relativePath !== `${boundary}/${ENTRY_NAME}` || source?.contentKind !== "text") return false;
    const original = splitSkillDocument(source.text),
        actual = splitSkillDocument(input.nativeEntry.content.text);
    return original !== null && actual !== null && original.prefix === actual.prefix && actual.body === input.canonicalEntry.text;
}

function parseChangedOpencodeSkillFile(
    input: {
        assetKind: "Skill";
        nativeDialectId: string;
        relativePath: PosixRelativePath;
        appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
        currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    },
    expectedNativeDialectId: string,
) {
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== expectedNativeDialectId ||
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
    const parsed = parseOpencodeFrontmatter(nativeText);
    if (!parsed.hasFrontmatter || !parsed.closed || parsed.body.trim() === "" || parsed.diagnostics.length !== 0) return null;
    return { prefix: nativeText.slice(0, nativeText.length - parsed.body.length), body: parsed.body };
}

function isOpencodeSkillBoundary(value: string, spec: SkillVariantSpec): boolean {
    if (!isCanonicalRelativePath(value)) return false;
    const segments = value.split("/");
    if (spec.targetKind === "project") {
        return (
            segments.length === 3 &&
            ((segments[0] === ".opencode" && (segments[1] === "skill" || segments[1] === "skills")) ||
                ((segments[0] === ".agents" || segments[0] === ".claude") && segments[1] === "skills"))
        );
    }
    if (spec.targetKind === "global") {
        return segments.length === 2 && (segments[0] === "skill" || segments[0] === "skills");
    }
    return segments.length === 1 && segments[0] !== ".system";
}

function replaceFixtureBoundary(boundary: PosixRelativePath, assetPrefix: string): PosixRelativePath {
    const segments = boundary.split("/");
    segments[segments.length - 1] = `oaam-skill-${assetPrefix}`;
    return segments.join("/") as PosixRelativePath;
}

function validatesRebasedGraph(
    input: NativeProjectExactGraphRebaseInput,
    nativeFiles: RenderNativeRepresentationFileInput[],
): boolean {
    return validateOpencodeNativeDialect({
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
    } = file as RenderNativeRepresentationFileInput & { text?: string; bytes?: Uint8Array };
    return descriptor;
}

function isPortableOpencodeSkill(value: SkillTypeDataV2): boolean {
    const userInvocation = value.invocation.user;
    return (
        value.schemaVersion === 2 &&
        value.name.trim() !== "" &&
        value.description.trim() !== "" &&
        (value.whenToUse === "" || value.whenToUse === value.description) &&
        value.name.length <= 256 &&
        value.description.length <= 4096 &&
        value.invocation.pathCondition.mode === "none" &&
        (userInvocation.mode === "not_directly_invocable" ||
            (userInvocation.mode === "direct" && userInvocation.commandName === value.name)) &&
        value.invocation.model.mode === "model_decision" &&
        value.invocation.argumentNames.length === 0 &&
        value.invocation.argumentHint === "" &&
        value.toolPolicy.preapproved.length === 0 &&
        value.toolPolicy.denied.length === 0 &&
        value.toolPolicy.otherwise === "inherit_agent_runtime_policy" &&
        value.execution.mode === "caller" &&
        value.execution.model.mode === "inherit" &&
        value.execution.effort.mode === "inherit"
    );
}

function assessCanonicalOpencodeSkillLoss(input: CanonicalMaterializationAssessmentInput, spec: SkillVariantSpec) {
    if (
        spec.interpretation !== 2 ||
        input.nativeDialectId !== OPENCODE_NATIVE_DIALECTS.skillCli ||
        input.targetScope !== spec.scope ||
        input.canonical.kind !== "Skill" ||
        input.canonicalEntry.contentKind !== "text" ||
        input.canonicalEntry.text.trim() === "" ||
        !isPortableOpencodeSkill(input.canonical.typeData)
    )
        return null;
    if (spec.requiresNativeSourceAssessment !== true) {
        if (
            input.nativePreservationSeed !== undefined &&
            (input.nativePreservationSeed.representation.dialectId !== OPENCODE_NATIVE_DIALECTS.skill ||
                projectPreservedSkillSource(input.nativePreservationSeed.files) === null)
        )
            return null;
        return input.canonical.typeData.invocation.user.mode === "not_directly_invocable"
            ? ["trigger_or_loading_level_lost" as const]
            : [];
    }
    const seed = input.nativePreservationSeed;
    // The v1-to-v2 path continues to retain the original OpenCode header, including unowned bytes.
    const metadataLosses =
        seed?.representation.dialectId === OPENCODE_NATIVE_DIALECTS.skill
            ? projectPreservedSkillSource(seed.files) === null
                ? null
                : []
            : assessForeignSkillMetadata(input);
    if (metadataLosses === null) return null;
    return [
        ...metadataLosses,
        ...(input.canonical.typeData.invocation.user.mode === "not_directly_invocable"
            ? ["trigger_or_loading_level_lost" as const]
            : []),
    ];
}

function validateCanonicalOpencodeSkillEntry(input: CanonicalRenderEntryValidationInput, spec: SkillVariantSpec): boolean {
    if (
        input.canonical.kind !== "Skill" ||
        input.nativeDialectId !== opencodeSkillDialect(spec.interpretation ?? 1) ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text" ||
        input.targetScope !== spec.scope ||
        !isPortableOpencodeSkill(input.canonical.typeData) ||
        (spec.requiresNativeSourceAssessment === true && assessCanonicalOpencodeSkillLoss(input, spec) === null)
    )
        return false;
    if (
        input.nativePreservationSeed !== undefined &&
        (spec.requiresNativeSourceAssessment !== true ||
            input.nativePreservationSeed.representation.dialectId === OPENCODE_NATIVE_DIALECTS.skill)
    )
        return validatePreservedOpencodeSkillEntry(input, spec);
    const boundary = replaceFixtureBoundary(spec.targetBoundary, input.targetVersion.assetId.slice(0, 8));
    if (input.nativeEntry.relativePath !== `${boundary}/${ENTRY_NAME}`) return false;
    const data = input.canonical.typeData;
    const parsed = parseOpencodeFrontmatter(input.nativeEntry.content.text);
    const expected: Record<string, unknown> = { name: data.name, description: data.description };
    if (data.invocation.user.mode === "direct") expected.slash = true;
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

/** Source contract and policy expressibility are checked before this metadata-only assessment. */
function assessForeignSkillMetadata(
    input: CanonicalMaterializationAssessmentInput,
): ["runtime_specific_metadata_lost"] | [] | null {
    const seed = input.nativePreservationSeed;
    if (
        input.canonical.kind !== "Skill" ||
        input.canonicalEntry.contentKind !== "text" ||
        (seed !== undefined && !CANONICAL_SOURCE_DIALECTS.includes(seed.representation.dialectId))
    )
        return null;
    // The Core guard excludes an unselected current private representation from this branch.
    if (seed === undefined) return [];
    // Select the owning entry; a nested SKILL.md resource must not create false entry ambiguity.
    const entries =
        seed.representation.dialectId === "antigravity-skill-flat-v1"
            ? seed.files.filter((file) => seed.files.length === 1 && file.relativePath.endsWith(".md"))
            : seed.files.filter(
                  (file) =>
                      file.relativePath.endsWith(`/${ENTRY_NAME}`) &&
                      seed.files.every((owned) => owned.relativePath.startsWith(file.relativePath.slice(0, -ENTRY_NAME.length))),
              );
    const entry = entries[0];
    if (entries.length !== 1 || entry?.contentKind !== "text") return null;
    const parsed = parseOpencodeFrontmatter(entry.text);
    if ((parsed.hasFrontmatter && !parsed.closed) || parsed.diagnostics.length !== 0 || parsed.body !== input.canonicalEntry.text)
        return null;
    const data = input.canonical.typeData;
    const mapped: Record<string, unknown> = {
        name: data.name,
        description: data.description,
        license: data.portableMetadata.license,
        compatibility: data.portableMetadata.compatibility,
        metadata: data.portableMetadata.metadata,
    };
    let metadataLost = false;
    for (const [key, value] of Object.entries(parsed.values)) {
        if (key === "name" || key === "description") {
            if (!stableSourceValueEqual(value, mapped[key])) return null;
        } else if (key === "license" || key === "compatibility" || key === "metadata") {
            if (!stableSourceValueEqual(value, mapped[key])) metadataLost = true;
        } else if (key === "version" && seed.representation.dialectId === "claudecode-skill-directory-v1") {
            metadataLost = true;
        } else if (!EXPRESSIBLE_SOURCE_FIELDS[seed.representation.dialectId]?.includes(key)) {
            // Metadata approval cannot authorize dropping an unknown behavior-bearing field.
            return null;
        }
    }
    return metadataLost ? ["runtime_specific_metadata_lost"] : [];
}

function serializeSkillFrontmatter(typeData: SkillTypeDataV2): string {
    const lines = ["---", `name: ${JSON.stringify(typeData.name)}`, `description: ${JSON.stringify(typeData.description)}`];
    if (typeData.invocation.user.mode === "direct") lines.push("slash: true");
    if (typeData.portableMetadata.license !== "") lines.push(`license: ${JSON.stringify(typeData.portableMetadata.license)}`);
    if (typeData.portableMetadata.compatibility !== "") {
        lines.push(`compatibility: ${JSON.stringify(typeData.portableMetadata.compatibility)}`);
    }
    const metadata = Object.entries(typeData.portableMetadata.metadata).sort(([left], [right]) => compareText(left, right));
    if (metadata.length > 0) {
        lines.push("metadata:", ...metadata.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`));
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

function binaryNativeFile(relativePath: PosixRelativePath, bytes: Uint8Array, mediaType: string, executable: boolean) {
    const copy = new Uint8Array(bytes);
    return {
        relativePath,
        contentKind: "binary" as const,
        mediaType,
        executable,
        contentHash: sha256SourceBytes(copy),
        byteSize: copy.byteLength,
        bytes: copy,
    };
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

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
