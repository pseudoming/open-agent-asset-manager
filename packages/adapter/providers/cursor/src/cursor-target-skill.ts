/** Exact Cursor Agent CLI/App project/personal Skill directory-graph targets. */

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
import { CURSOR_SKILL_SOURCE_DIALECTS, assessCursorSkillSourceMetadata } from "./cursor-skill-conversion-assessment";
import { parseCursorFrontmatter } from "./cursor-frontmatter";
import { CURSOR_NATIVE_DIALECTS } from "./cursor-source-read-model";
import { validateCursorNativeDialect } from "./cursor-source-read-native";
import {
    appendCursorBuildCompatibilityWarning,
    CURSOR_AGENT_TARGET_BUILD_COMPATIBILITY,
} from "./cursor-target-build-compatibility";

const ENTRY_NAME = "SKILL.md";
const PROJECT_FACTS = { "oaam.project-binding": "registered" } as const;
const GLOBAL_FACTS = { "oaam.target-kind": "global" } as const;
const DIRECTORY_FACTS = { "oaam.target-kind": "directory" } as const;
const LEGACY_CANONICAL_DEGRADATIONS = [
    "permission_or_tool_boundary_lost",
    "runtime_specific_metadata_lost",
    "trigger_or_loading_level_lost",
] as const;

export interface CursorSkillTargetSupports {
    projectFolder: NativeProjectExactGraphProviderSupport;
    globalConfigFolder: NativeGlobalExactGraphProviderSupport;
    globalDirectoryFolder: NativeGlobalExactGraphProviderSupport;
}

interface SkillVariantSpec {
    key: keyof CursorSkillTargetSupports;
    scope: "project" | "global";
    targetKind: "project" | "global" | "directory";
    targetBoundary: PosixRelativePath;
    graphComponent: (typeof CURSOR_SKILL_TARGET_COMPONENTS)["projectFolder" | "globalConfigFolder" | "globalDirectoryFolder"];
    canonicalComponent: (typeof CURSOR_SKILL_TARGET_COMPONENTS)[
        | "projectCanonical"
        | "globalConfigCanonical"
        | "globalDirectoryCanonical"];
    outputContractId: string;
    materializationProfileId: string;
    materializerCapabilityKey: string;
    fixtureSlug: string;
    loadMarker: string;
}

interface CursorSkillRuntimeSpec {
    agentRuntimeId: "CURSOR_AGENT_CLI" | "CURSOR_APP";
    profilePrefix: string;
    capabilityPrefix: string;
    outputPrefix: string;
    builds: readonly {
        versionText: string;
        buildIdentity: `sha256:${string}`;
        platform: "linux" | "win32" | "wsl";
        fixturePrefix: string;
    }[];
}

const CLI_RUNTIME: CursorSkillRuntimeSpec = {
    agentRuntimeId: "CURSOR_AGENT_CLI",
    profilePrefix: "cursor-agent-cli",
    capabilityPrefix: "cursor.agent-cli",
    outputPrefix: "CURSOR_AGENT_CLI",
    builds: [
        {
            versionText: "2026.07.23-e383d2b",
            buildIdentity: "sha256:eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831",
            platform: "wsl",
            fixturePrefix: "cursor-agent-cli-2026.07.23-wsl",
        },
    ],
};

const APP_RUNTIME: CursorSkillRuntimeSpec = {
    agentRuntimeId: "CURSOR_APP",
    profilePrefix: "cursor-app",
    capabilityPrefix: "cursor.app",
    outputPrefix: "CURSOR_APP",
    builds: [
        {
            versionText: "3.13.25",
            buildIdentity: "sha256:98c0fc2885636738e986e01af8f9c5229dad4b2d7510bc489c9ffc0924da4904",
            platform: "linux",
            fixturePrefix: "cursor-app-3.13.25-linux",
        },
        {
            versionText: "3.12.30",
            buildIdentity: "sha256:4defe15e408c98082ee766f761ec77f9504f74727f57446a135b87bb44a4254e",
            platform: "win32",
            fixturePrefix: "cursor-app-3.12.30-win32",
        },
    ],
};

export const CURSOR_SKILL_TARGET_COMPONENTS = {
    projectFolder: component("cursor.project-skill-directory-graph-v1"),
    globalConfigFolder: component("cursor.global-config-skill-directory-graph-v1"),
    globalDirectoryFolder: component("cursor.global-direct-skill-directory-graph-v1"),
    reverse: component(`${CURSOR_NATIVE_DIALECTS.skill}.native-to-canonical-parser`),
    rebase: component("cursor.skill-directory-parent-rebase-v1"),
    projectCanonical: component("cursor.project-skill-reviewed-canonical-materialization-v2"),
    globalConfigCanonical: component("cursor.global-config-skill-reviewed-canonical-materialization-v2"),
    globalDirectoryCanonical: component("cursor.global-direct-skill-reviewed-canonical-materialization-v2"),
} as const;

const VARIANTS: readonly SkillVariantSpec[] = [
    {
        key: "projectFolder",
        scope: "project",
        targetKind: "project",
        targetBoundary: ".cursor/skills/oaam-phase58-skill-graph" as PosixRelativePath,
        graphComponent: CURSOR_SKILL_TARGET_COMPONENTS.projectFolder,
        canonicalComponent: CURSOR_SKILL_TARGET_COMPONENTS.projectCanonical,
        outputContractId: "CURSOR_AGENT_CLI_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
        materializationProfileId: "cursor-agent-cli-project-skill-directory-v1",
        materializerCapabilityKey: "cursor.agent-cli-project-skill-directory-v1",
        fixtureSlug: "project-skill-directory",
        loadMarker: "OAAM_CURSOR_AGENT_PROJECT_SKILL_GRAPH_6B2D91",
    },
    {
        key: "globalConfigFolder",
        scope: "global",
        targetKind: "global",
        targetBoundary: "skills/oaam-phase58-global-skill-graph" as PosixRelativePath,
        graphComponent: CURSOR_SKILL_TARGET_COMPONENTS.globalConfigFolder,
        canonicalComponent: CURSOR_SKILL_TARGET_COMPONENTS.globalConfigCanonical,
        outputContractId: "CURSOR_AGENT_CLI_NATIVE_GLOBAL_CONFIG_SKILL_DIRECTORY_V1",
        materializationProfileId: "cursor-agent-cli-global-config-skill-directory-v1",
        materializerCapabilityKey: "cursor.agent-cli-global-config-skill-directory-v1",
        fixtureSlug: "global-config-skill-directory",
        loadMarker: "OAAM_CURSOR_AGENT_GLOBAL_CONFIG_SKILL_GRAPH_41E8C7",
    },
    {
        key: "globalDirectoryFolder",
        scope: "global",
        targetKind: "directory",
        targetBoundary: "oaam-phase58-global-direct-skill" as PosixRelativePath,
        graphComponent: CURSOR_SKILL_TARGET_COMPONENTS.globalDirectoryFolder,
        canonicalComponent: CURSOR_SKILL_TARGET_COMPONENTS.globalDirectoryCanonical,
        outputContractId: "CURSOR_AGENT_CLI_NATIVE_GLOBAL_DIRECT_SKILL_DIRECTORY_V1",
        materializationProfileId: "cursor-agent-cli-global-direct-skill-directory-v1",
        materializerCapabilityKey: "cursor.agent-cli-global-direct-skill-directory-v1",
        fixtureSlug: "global-direct-skill-directory",
        loadMarker: "OAAM_CURSOR_AGENT_GLOBAL_DIRECT_SKILL_GRAPH_8F70A2",
    },
];

export function createCursorCliSkillTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
    globalDirectoryTargetContextSchemaId: string;
    assessCanonicalLoss?: boolean;
}): CursorSkillTargetSupports {
    return createSkillTargetSupports(CLI_RUNTIME, input);
}

export function createCursorAppSkillTargetSupports(
    input: Parameters<typeof createCursorCliSkillTargetSupports>[0],
): CursorSkillTargetSupports {
    return createSkillTargetSupports(APP_RUNTIME, input);
}

function createSkillTargetSupports(
    runtime: CursorSkillRuntimeSpec,
    input: Parameters<typeof createCursorCliSkillTargetSupports>[0],
): CursorSkillTargetSupports {
    return Object.fromEntries(
        VARIANTS.map((spec) => [spec.key, createVariantSupport(spec, runtime, input)]),
    ) as unknown as CursorSkillTargetSupports;
}

function createVariantSupport(
    spec: SkillVariantSpec,
    runtime: CursorSkillRuntimeSpec,
    input: Parameters<typeof createCursorCliSkillTargetSupports>[0],
): NativeProjectExactGraphProviderSupport | NativeGlobalExactGraphProviderSupport {
    const targetBoundary = runtimeTargetBoundary(spec, runtime);
    const outputContractId = `${runtime.outputPrefix}_NATIVE_${spec.scope === "project" ? "PROJECT" : spec.targetKind === "global" ? "GLOBAL_CONFIG" : "GLOBAL_DIRECT"}_SKILL_DIRECTORY_V1`;
    const materializationProfileId = `${runtime.profilePrefix}-${spec.fixtureSlug}-v1`;
    const materializerCapabilityKey = `${runtime.capabilityPrefix}-${spec.fixtureSlug}-v1`;
    const fixturePaths = [
        `${targetBoundary}/SKILL.md`,
        `${targetBoundary}/assets/marker.bin`,
        `${targetBoundary}/references/details.md`,
        `${targetBoundary}/scripts/marker.py`,
    ] as PosixRelativePath[];
    const assessesLoss = input.assessCanonicalLoss !== false;
    const canonicalComponent = assessesLoss
        ? spec.canonicalComponent
        : component(spec.canonicalComponent.componentId.replace(/-v2$/u, "-v1"));
    const degradationKinds = assessesLoss
        ? (["runtime_specific_metadata_lost"] as ["runtime_specific_metadata_lost"])
        : ([...LEGACY_CANONICAL_DEGRADATIONS] as [
              "permission_or_tool_boundary_lost",
              "runtime_specific_metadata_lost",
              "trigger_or_loading_level_lost",
          ]);
    const canonicalDeclaration = {
        materializer: canonicalComponent,
        degradationKinds,
        reasonCode: "cursor_skill_reviewed_canonical_conversion",
        ...(assessesLoss
            ? {
                  preservationDialectIds: [...CURSOR_SKILL_SOURCE_DIALECTS],
                  assessesLoss: true as const,
                  requiresNativeSourceAssessment: true as const,
              }
            : {}),
    };
    const builds = runtime.builds.map((build) => {
        const commonBuild = {
            agentRuntimeId: runtime.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId,
            fixtureId: `${build.fixturePrefix}-${spec.fixtureSlug}-2026-08-09`,
            assetKind: "Skill" as const,
            nativeDialectId: CURSOR_NATIVE_DIALECTS.skill,
            reverseParser: CURSOR_SKILL_TARGET_COMPONENTS.reverse,
            rebaseMaterializer: CURSOR_SKILL_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: canonicalDeclaration,
            restorationDialectIds: [],
            parentRebaseFixtureId: `${build.fixturePrefix}-${spec.fixtureSlug}-parent-rebase-v1`,
            targetGraphIdentity: fixturePaths[0] as PosixRelativePath,
            targetRelativePaths: fixturePaths,
            exactLoadMarker:
                runtime.agentRuntimeId === "CURSOR_APP" ? `OAAM_CURSOR_APP_${spec.key.toUpperCase()}_85E1` : spec.loadMarker,
            reverseFixtureId: `${build.fixturePrefix}-${spec.fixtureSlug}-reverse-v1`,
        };
        return spec.scope === "project"
            ? createVerifiedNativeProjectExactGraphBuild({ ...commonBuild, projectGraphValidator: spec.graphComponent })
            : createVerifiedNativeGlobalExactGraphBuild({ ...commonBuild, globalGraphValidator: spec.graphComponent });
    });
    const canonicalMaterializer: NativeProjectExactGraphCanonicalMaterializer = {
        ref: canonicalComponent,
        degradationKinds,
        ...(assessesLoss
            ? {
                  preservationDialectIds: [...CURSOR_SKILL_SOURCE_DIALECTS],
                  requiresNativeSourceAssessment: true,
                  assessLoss: (value: CanonicalMaterializationAssessmentInput) => assessCursorSkillLoss(value, spec.scope),
              }
            : {}),
        reasonCode: "cursor_skill_reviewed_canonical_conversion",
        diagnosticMessage:
            "The complete Skill graph and metadata mapping are preserved; fields without a Cursor mapping, including license and compatibility, remain in the saved source Version",
        materialize: (materializationInput) =>
            materializeCanonicalCursorSkill(materializationInput, spec, targetBoundary, assessesLoss),
        validateEntry: (validationInput) =>
            validateCanonicalCursorSkillEntry(validationInput, spec, targetBoundary, assessesLoss),
    };
    const common = {
        adapterId: "CURSOR" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: runtime.agentRuntimeId,
        assetKind: "Skill" as const,
        outputContractId,
        materializationProfileId,
        materializerCapabilityKey,
        nativeDialectId: CURSOR_NATIVE_DIALECTS.skill,
        reverseParser: { ref: CURSOR_SKILL_TARGET_COMPONENTS.reverse, parse: parseChangedCursorSkillFile },
        rebaseMaterializer: CURSOR_SKILL_REBASE_MATERIALIZER,
        canonicalMaterializer,
        restorationDialectIds: [],
        buildCompatibility: CURSOR_AGENT_TARGET_BUILD_COMPATIBILITY,
    };
    const validate = (files: readonly RenderNativeRepresentationFileInput[]) => projectCursorSkillGraph(files, spec);
    if (spec.scope === "project") {
        return createNativeProjectExactGraphProviderSupport({
            ...common,
            projectGraphValidator: { ref: spec.graphComponent, project: validate },
            target: { targetContextSchemaId: input.projectTargetContextSchemaId, requiredFacts: PROJECT_FACTS },
            verifiedBuilds: builds as ReturnType<typeof createVerifiedNativeProjectExactGraphBuild>[],
        });
    }
    return createNativeGlobalExactGraphProviderSupport({
        ...common,
        globalGraphValidator: { ref: spec.graphComponent, validate },
        target: {
            targetContextSchemaId:
                spec.targetKind === "global" ? input.globalTargetContextSchemaId : input.globalDirectoryTargetContextSchemaId,
            requiredFacts: spec.targetKind === "global" ? GLOBAL_FACTS : DIRECTORY_FACTS,
        },
        verifiedBuilds: builds as ReturnType<typeof createVerifiedNativeGlobalExactGraphBuild>[],
    });
}

export async function analyzeCursorSkillTargets(
    input: RenderAnalysisInput,
    supports: CursorSkillTargetSupports,
): Promise<AdapterRenderAnalysisResult> {
    const scopes = new Set(input.deployment.assets.map((asset) => asset.scope));
    const contextIds = new Set(input.deployment.targetContexts.map((context) => context.targetContextSchemaId));
    const matches = VARIANTS.filter(
        (spec) =>
            scopes.size === 1 &&
            scopes.has(spec.scope) &&
            contextIds.has(supports[spec.key].targetContextSchema.targetContextSchemaId),
    );
    const spec = matches.length === 1 ? matches[0] : undefined;
    if (spec !== undefined) {
        const support = supports[spec.key];
        return appendCursorBuildCompatibilityWarning(await support.analyze(input), input, support.renderContractDeclaration);
    }
    const issue = diagnostic(
        "render",
        "cursor_skill_target_shape_ambiguous",
        "One Cursor Skill Deployment must use one exact Project, personal config or direct shared Skill-directory target",
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

export const CURSOR_SKILL_REBASE_MATERIALIZER: NativeProjectExactGraphRebaseMaterializer = {
    ref: CURSOR_SKILL_TARGET_COMPONENTS.rebase,
    materialize: materializeCursorSkillParentGraph,
};

function projectCursorSkillGraph(files: readonly RenderNativeRepresentationFileInput[], spec: SkillVariantSpec) {
    if (files.length === 0) return null;
    const paths = files.map((file) => file.relativePath);
    if (new Set(paths).size !== paths.length) return null;
    const entries = paths.filter((relativePath) => relativePath.endsWith(`/${ENTRY_NAME}`));
    if (entries.length !== 1) return null;
    const entryPath = entries[0] as PosixRelativePath;
    const boundary = entryPath.slice(0, -(ENTRY_NAME.length + 1));
    if (!isCursorSkillBoundary(boundary, spec) || paths.some((value) => !isStrictDescendant(value, boundary))) return null;
    return {
        graphIdentityRelativePath: entryPath,
        files: paths.map((nativeRelativePath) => ({
            nativeRelativePath,
            canonicalLogicalPath: nativeRelativePath.slice(boundary.length + 1) as PosixRelativePath,
        })),
        managedDirectoryBoundaries: [boundary as PosixRelativePath],
    };
}

function materializeCursorSkillParentGraph(
    input: NativeProjectExactGraphRebaseInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== CURSOR_NATIVE_DIALECTS.skill ||
        input.targetCanonical.kind !== "Skill" ||
        input.restorationInputs.length !== 0
    ) {
        return null;
    }
    const projections = VARIANTS.map((spec) => projectCursorSkillGraph(input.parent.files, spec)).filter(
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
    nativeFiles.sort(compareNativePath);
    return validatesRebasedGraph(input, nativeFiles) ? { nativeFiles } : null;
}

function materializeCanonicalCursorSkill(
    input: NativeProjectExactGraphCanonicalMaterializationInput,
    spec: SkillVariantSpec,
    targetBoundary: PosixRelativePath,
    assessesLoss: boolean,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    const canonical = input.targetCanonical;
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== CURSOR_NATIVE_DIALECTS.skill ||
        canonical.kind !== "Skill" ||
        input.targetScope !== spec.scope ||
        input.restorationInputs.length !== 0 ||
        !isPortableCursorSkill(canonical.typeData)
    ) {
        return null;
    }
    const entries = input.targetFiles.filter((file) => file.file.role === "entry");
    if (entries.length !== 1 || entries[0]?.file.logicalPath !== ENTRY_NAME || entries[0].contentKind !== "text") return null;
    if (
        assessesLoss &&
        assessCursorSkillLoss(
            {
                canonical,
                canonicalEntry: { contentKind: "text", text: entries[0].text },
                targetVersion: input.targetVersion,
                targetScope: input.targetScope,
                nativeDialectId: input.nativeDialectId,
                nativePreservationSeed: input.nativePreservationSeed,
            },
            spec.scope,
        ) === null
    )
        return null;
    const logicalPaths = input.targetFiles.map((file) => file.file.logicalPath);
    if (new Set(logicalPaths).size !== logicalPaths.length || logicalPaths.some((value) => !isCanonicalRelativePath(value))) {
        return null;
    }
    const boundary = replaceFixtureBoundary(targetBoundary, input.targetVersion.assetId.slice(0, 8));
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
    nativeFiles.sort(compareNativePath);
    return { nativeFiles };
}

function runtimeTargetBoundary(spec: SkillVariantSpec, runtime: CursorSkillRuntimeSpec): PosixRelativePath {
    if (runtime.agentRuntimeId === "CURSOR_AGENT_CLI") return spec.targetBoundary;
    if (spec.targetKind === "project") return ".cursor/skills/oaam-app-skill" as PosixRelativePath;
    if (spec.targetKind === "global") return "skills/oaam-phase59-app-global-skill-graph" as PosixRelativePath;
    return "oaam-phase59-app-global-direct-skill" as PosixRelativePath;
}

function parseChangedCursorSkillFile(input: {
    assetKind: "Skill";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}) {
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== CURSOR_NATIVE_DIALECTS.skill ||
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
    const parsed = parseCursorFrontmatter(nativeText);
    if (!parsed.hasFrontmatter || !parsed.closed || parsed.body.trim() === "" || parsed.diagnostics.length !== 0) return null;
    return { prefix: nativeText.slice(0, nativeText.length - parsed.body.length), body: parsed.body };
}

function isCursorSkillBoundary(value: string, spec: SkillVariantSpec): boolean {
    if (!isCanonicalRelativePath(value)) return false;
    const segments = value.split("/");
    if (spec.targetKind === "project") {
        return segments.length === 3 && (segments[0] === ".cursor" || segments[0] === ".agents") && segments[1] === "skills";
    }
    if (spec.targetKind === "global") return segments.length === 2 && segments[0] === "skills";
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
    return validateCursorNativeDialect({
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

function isPortableCursorSkill(value: SkillTypeDataV2): boolean {
    return (
        value.schemaVersion === 2 &&
        /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value.name) &&
        value.description.trim() !== "" &&
        value.description.length <= 1024 &&
        (value.whenToUse === "" || value.whenToUse === value.description) &&
        Object.keys(value.portableMetadata.metadata).every(
            (key) =>
                /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(key) &&
                !/^(?:null|true|false|y|n|yes|no|on|off)$/iu.test(key) &&
                !["__proto__", "prototype", "constructor"].includes(key),
        ) &&
        value.invocation.pathCondition.mode === "none" &&
        value.invocation.user.mode === "direct" &&
        value.invocation.user.commandName === value.name &&
        (value.invocation.model.mode === "model_decision" || value.invocation.model.mode === "disabled") &&
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

function validateCanonicalCursorSkillEntry(
    input: CanonicalRenderEntryValidationInput,
    spec: SkillVariantSpec,
    targetBoundary: PosixRelativePath,
    assessesLoss: boolean,
): boolean {
    if (
        (assessesLoss && assessCursorSkillLoss(input, spec.scope) === null) ||
        input.canonical.kind !== "Skill" ||
        input.nativeDialectId !== CURSOR_NATIVE_DIALECTS.skill ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text" ||
        input.targetScope !== spec.scope ||
        !isPortableCursorSkill(input.canonical.typeData)
    )
        return false;
    const boundary = replaceFixtureBoundary(targetBoundary, input.targetVersion.assetId.slice(0, 8));
    if (input.nativeEntry.relativePath !== `${boundary}/${ENTRY_NAME}`) return false;
    const data = input.canonical.typeData;
    const parsed = parseCursorFrontmatter(input.nativeEntry.content.text);
    const expected: Record<string, unknown> = { name: data.name, description: data.description };
    if (data.invocation.model.mode === "disabled") expected["disable-model-invocation"] = true;
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
    if (typeData.invocation.model.mode === "disabled") lines.push("disable-model-invocation: true");
    const metadata = Object.entries(typeData.portableMetadata.metadata).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
    );
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

function compareNativePath(left: RenderNativeRepresentationFileInput, right: RenderNativeRepresentationFileInput): number {
    return compareText(left.relativePath, right.relativePath);
}

function assessCursorSkillLoss(input: CanonicalMaterializationAssessmentInput, scope: "project" | "global") {
    if (
        input.canonical.kind !== "Skill" ||
        input.nativeDialectId !== CURSOR_NATIVE_DIALECTS.skill ||
        input.targetScope !== scope ||
        !isPortableCursorSkill(input.canonical.typeData)
    )
        return null;
    return assessCursorSkillSourceMetadata(input);
}
