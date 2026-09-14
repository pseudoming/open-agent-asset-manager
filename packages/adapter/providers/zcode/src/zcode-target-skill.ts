/** ZCode App project/config/directory Skill targets over the exact native graph contract. */

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
import { parseZcodeFrontmatter } from "./zcode-frontmatter";
import { ZCODE_NATIVE_DIALECTS } from "./zcode-source-read-model";
import { validateZcodeNativeDialect } from "./zcode-source-read-native";
import { appendZcodeBuildCompatibilityWarning, ZCODE_APP_TARGET_BUILD_COMPATIBILITY } from "./zcode-target-build-compatibility";
import { ZCODE_CURRENT_TARGET_BUILD, ZCODE_HISTORICAL_DECLARATION_FLOOR } from "./zcode-target-builds";

const ENTRY_NAME = "SKILL.md";
const PROJECT_FACTS = { "oaam.project-binding": "registered" } as const;
const GLOBAL_FACTS = { "oaam.target-kind": "global" } as const;
const DIRECTORY_FACTS = { "oaam.target-kind": "directory" } as const;
const CANONICAL_DEGRADATIONS = [
    "permission_or_tool_boundary_lost",
    "runtime_specific_metadata_lost",
    "trigger_or_loading_level_lost",
] as const;

export interface ZcodeSkillTargetSupports {
    projectFolder: NativeProjectExactGraphProviderSupport;
    globalConfigFolder: NativeGlobalExactGraphProviderSupport;
    globalDirectoryFolder: NativeGlobalExactGraphProviderSupport;
}

interface SupportFactoryInput {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
    globalDirectoryTargetContextSchemaId: string;
}

interface SkillVariantSpec {
    key: keyof ZcodeSkillTargetSupports;
    scope: "project" | "global";
    targetKind: "project" | "global" | "directory";
    targetBoundary: PosixRelativePath;
    graphComponent: (typeof ZCODE_SKILL_TARGET_COMPONENTS)["projectFolder" | "globalConfigFolder" | "globalDirectoryFolder"];
    canonicalComponent: (typeof ZCODE_SKILL_TARGET_COMPONENTS)[
        | "projectCanonical"
        | "globalConfigCanonical"
        | "globalDirectoryCanonical"];
    outputContractId: string;
    materializationProfileId: string;
    materializerCapabilityKey: string;
    fixtureSlug: string;
    loadMarker: string;
}

export const ZCODE_SKILL_TARGET_COMPONENTS = {
    projectFolder: component("zcode.project-skill-directory-graph-v1"),
    globalConfigFolder: component("zcode.global-config-skill-directory-graph-v1"),
    globalDirectoryFolder: component("zcode.global-direct-skill-directory-graph-v1"),
    reverse: component(`${ZCODE_NATIVE_DIALECTS.skill}.native-to-canonical-parser`),
    rebase: component("zcode.skill-directory-parent-rebase-v1"),
    projectCanonical: component("zcode.project-skill-reviewed-canonical-materialization-v1"),
    globalConfigCanonical: component("zcode.global-config-skill-reviewed-canonical-materialization-v1"),
    globalDirectoryCanonical: component("zcode.global-direct-skill-reviewed-canonical-materialization-v1"),
} as const;

const VARIANTS: readonly SkillVariantSpec[] = [
    {
        key: "projectFolder",
        scope: "project",
        targetKind: "project",
        targetBoundary: ".zcode/skills/oaam-phase56-skill-graph" as PosixRelativePath,
        graphComponent: ZCODE_SKILL_TARGET_COMPONENTS.projectFolder,
        canonicalComponent: ZCODE_SKILL_TARGET_COMPONENTS.projectCanonical,
        outputContractId: "ZCODE_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
        materializationProfileId: "zcode-app-project-skill-directory-v1",
        materializerCapabilityKey: "zcode.project-skill-directory-v1",
        fixtureSlug: "project-skill-directory",
        loadMarker: "OAAM_ZCODE_353_PROJECT_SKILL_GRAPH_6B2D91",
    },
    {
        key: "globalConfigFolder",
        scope: "global",
        targetKind: "global",
        targetBoundary: "skills/oaam-phase56-global-skill-graph" as PosixRelativePath,
        graphComponent: ZCODE_SKILL_TARGET_COMPONENTS.globalConfigFolder,
        canonicalComponent: ZCODE_SKILL_TARGET_COMPONENTS.globalConfigCanonical,
        outputContractId: "ZCODE_NATIVE_GLOBAL_CONFIG_SKILL_DIRECTORY_V1",
        materializationProfileId: "zcode-app-global-config-skill-directory-v1",
        materializerCapabilityKey: "zcode.global-config-skill-directory-v1",
        fixtureSlug: "global-config-skill-directory",
        loadMarker: "OAAM_ZCODE_353_GLOBAL_CONFIG_SKILL_GRAPH_41E8C7",
    },
    {
        key: "globalDirectoryFolder",
        scope: "global",
        targetKind: "directory",
        targetBoundary: "oaam-phase56-global-direct-skill" as PosixRelativePath,
        graphComponent: ZCODE_SKILL_TARGET_COMPONENTS.globalDirectoryFolder,
        canonicalComponent: ZCODE_SKILL_TARGET_COMPONENTS.globalDirectoryCanonical,
        outputContractId: "ZCODE_NATIVE_GLOBAL_DIRECT_SKILL_DIRECTORY_V1",
        materializationProfileId: "zcode-app-global-direct-skill-directory-v1",
        materializerCapabilityKey: "zcode.global-direct-skill-directory-v1",
        fixtureSlug: "global-direct-skill-directory",
        loadMarker: "OAAM_ZCODE_353_GLOBAL_DIRECT_SKILL_GRAPH_8F70A2",
    },
];

export function createZcodeSkillTargetSupports(input: SupportFactoryInput): ZcodeSkillTargetSupports {
    return Object.fromEntries(
        VARIANTS.map((spec) => [spec.key, createVariantSupport(spec, input)]),
    ) as unknown as ZcodeSkillTargetSupports;
}

function createVariantSupport(
    spec: SkillVariantSpec,
    input: SupportFactoryInput,
): NativeProjectExactGraphProviderSupport | NativeGlobalExactGraphProviderSupport {
    const fixturePaths = [
        `${spec.targetBoundary}/SKILL.md`,
        `${spec.targetBoundary}/assets/marker.bin`,
        `${spec.targetBoundary}/references/details.md`,
        `${spec.targetBoundary}/scripts/marker.py`,
    ] as PosixRelativePath[];
    const canonicalDeclaration = {
        materializer: spec.canonicalComponent,
        degradationKinds: [...CANONICAL_DEGRADATIONS] as [
            "permission_or_tool_boundary_lost",
            "runtime_specific_metadata_lost",
            "trigger_or_loading_level_lost",
        ],
        reasonCode: "zcode_skill_reviewed_canonical_conversion",
    };
    const buildSpecs = [
        ...(["wsl", "win32"] as const).map((platform) => ({
            versionText: ZCODE_CURRENT_TARGET_BUILD.versionText,
            buildIdentity: ZCODE_CURRENT_TARGET_BUILD.buildIdentity,
            platform,
            fixtureSuffix: "2026-08-08",
            loadMarker: spec.loadMarker,
        })),
        ...(spec.key === "globalDirectoryFolder"
            ? []
            : [
                  {
                      ...ZCODE_HISTORICAL_DECLARATION_FLOOR,
                      fixtureSuffix: "historical-lifecycle-2026-08-17",
                      loadMarker: `OAAM_ZCODE_HISTORICAL_${spec.key.toUpperCase()}_3_1_8`,
                  },
              ]),
    ] as const;
    const builds = buildSpecs.map((buildSpec) => {
        const common = {
            agentRuntimeId: "ZCODE_APP" as const,
            versionText: buildSpec.versionText,
            buildIdentity: buildSpec.buildIdentity,
            platform: buildSpec.platform,
            materializationProfileId: spec.materializationProfileId,
            fixtureId: `zcode-app-${buildSpec.versionText}-${buildSpec.platform}-${spec.fixtureSlug}-${buildSpec.fixtureSuffix}`,
            assetKind: "Skill" as const,
            nativeDialectId: ZCODE_NATIVE_DIALECTS.skill,
            reverseParser: ZCODE_SKILL_TARGET_COMPONENTS.reverse,
            rebaseMaterializer: ZCODE_SKILL_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: canonicalDeclaration,
            restorationDialectIds: [],
            parentRebaseFixtureId: `zcode-app-${buildSpec.versionText}-${buildSpec.platform}-${spec.fixtureSlug}-parent-rebase-v1`,
            targetGraphIdentity: fixturePaths[0] as PosixRelativePath,
            targetRelativePaths: fixturePaths,
            exactLoadMarker: buildSpec.loadMarker,
            reverseFixtureId: `zcode-app-${buildSpec.versionText}-${buildSpec.platform}-${spec.fixtureSlug}-reverse-v1`,
        };
        return spec.scope === "project"
            ? createVerifiedNativeProjectExactGraphBuild({ ...common, projectGraphValidator: spec.graphComponent })
            : createVerifiedNativeGlobalExactGraphBuild({ ...common, globalGraphValidator: spec.graphComponent });
    });
    const canonicalMaterializer: NativeProjectExactGraphCanonicalMaterializer = {
        ref: spec.canonicalComponent,
        degradationKinds: [...CANONICAL_DEGRADATIONS],
        reasonCode: "zcode_skill_reviewed_canonical_conversion",
        diagnosticMessage:
            "OAAM can preserve the portable Skill graph, but source-runtime loading, private policy and trigger metadata do not have proven ZCode equivalents",
        materialize: (materializationInput) => materializeCanonicalZcodeSkill(materializationInput, spec),
        validateEntry: (validationInput) => validateCanonicalZcodeSkillEntry(validationInput, spec),
    };
    const common = {
        adapterId: "ZCODE" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: "ZCODE_APP" as const,
        assetKind: "Skill" as const,
        outputContractId: spec.outputContractId,
        materializationProfileId: spec.materializationProfileId,
        materializerCapabilityKey: spec.materializerCapabilityKey,
        nativeDialectId: ZCODE_NATIVE_DIALECTS.skill,
        reverseParser: {
            ref: ZCODE_SKILL_TARGET_COMPONENTS.reverse,
            parse: parseChangedZcodeSkillFile,
        },
        rebaseMaterializer: ZCODE_SKILL_REBASE_MATERIALIZER,
        canonicalMaterializer,
        restorationDialectIds: [],
        buildCompatibility: ZCODE_APP_TARGET_BUILD_COMPATIBILITY,
    };
    const validate = (files: readonly RenderNativeRepresentationFileInput[]) => projectZcodeSkillGraph(files, spec);
    if (spec.scope === "project") {
        return createNativeProjectExactGraphProviderSupport({
            ...common,
            projectGraphValidator: { ref: spec.graphComponent, project: validate },
            target: {
                targetContextSchemaId: input.projectTargetContextSchemaId,
                requiredFacts: PROJECT_FACTS,
            },
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

export async function analyzeZcodeSkillTargets(
    input: RenderAnalysisInput,
    supports: ZcodeSkillTargetSupports,
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
        return appendZcodeBuildCompatibilityWarning(await support.analyze(input), input, support.renderContractDeclaration);
    }
    const issue = diagnostic(
        "render",
        "zcode_skill_target_shape_ambiguous",
        "One ZCode Skill Deployment must use one exact Project, global config or direct Skill-directory target",
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

export const ZCODE_SKILL_REBASE_MATERIALIZER: NativeProjectExactGraphRebaseMaterializer = {
    ref: ZCODE_SKILL_TARGET_COMPONENTS.rebase,
    materialize: materializeZcodeSkillParentGraph,
};

function projectZcodeSkillGraph(files: readonly RenderNativeRepresentationFileInput[], spec: SkillVariantSpec) {
    if (files.length === 0) return null;
    const paths = files.map((file) => file.relativePath);
    if (new Set(paths).size !== paths.length) return null;
    const entries = paths.filter((relativePath) => relativePath.endsWith(`/${ENTRY_NAME}`));
    if (entries.length !== 1) return null;
    const entryPath = entries[0] as PosixRelativePath;
    const boundary = entryPath.slice(0, -(ENTRY_NAME.length + 1));
    if (!isZcodeSkillBoundary(boundary, spec) || paths.some((path) => !isStrictDescendant(path, boundary))) return null;
    return {
        graphIdentityRelativePath: entryPath,
        files: paths.map((nativeRelativePath) => ({
            nativeRelativePath,
            canonicalLogicalPath: nativeRelativePath.slice(boundary.length + 1) as PosixRelativePath,
        })),
        managedDirectoryBoundaries: [boundary as PosixRelativePath],
    };
}

function materializeZcodeSkillParentGraph(
    input: NativeProjectExactGraphRebaseInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== ZCODE_NATIVE_DIALECTS.skill ||
        input.targetCanonical.kind !== "Skill" ||
        input.restorationInputs.length !== 0
    ) {
        return null;
    }
    const projections = VARIANTS.map((spec) => projectZcodeSkillGraph(input.parent.files, spec)).filter(
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

function materializeCanonicalZcodeSkill(
    input: NativeProjectExactGraphCanonicalMaterializationInput,
    spec: SkillVariantSpec,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    const canonical = input.targetCanonical;
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== ZCODE_NATIVE_DIALECTS.skill ||
        canonical.kind !== "Skill" ||
        input.targetScope !== spec.scope ||
        input.restorationInputs.length !== 0 ||
        !isPortableZcodeSkill(canonical.typeData)
    ) {
        return null;
    }
    const entries = input.targetFiles.filter((file) => file.file.role === "entry");
    if (entries.length !== 1 || entries[0]?.file.logicalPath !== ENTRY_NAME || entries[0].contentKind !== "text") return null;
    const logicalPaths = input.targetFiles.map((file) => file.file.logicalPath);
    if (new Set(logicalPaths).size !== logicalPaths.length || logicalPaths.some((value) => !isCanonicalRelativePath(value))) {
        return null;
    }
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

function parseChangedZcodeSkillFile(input: {
    assetKind: "Skill";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}) {
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== ZCODE_NATIVE_DIALECTS.skill ||
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
    const parsed = parseZcodeFrontmatter(nativeText);
    if (!parsed.hasFrontmatter || !parsed.closed || parsed.body.trim() === "" || parsed.diagnostics.length !== 0) return null;
    return { prefix: nativeText.slice(0, nativeText.length - parsed.body.length), body: parsed.body };
}

function isZcodeSkillBoundary(value: string, spec: SkillVariantSpec): boolean {
    if (!isCanonicalRelativePath(value)) return false;
    const segments = value.split("/");
    if (spec.targetKind === "project") {
        return segments.length === 3 && (segments[0] === ".zcode" || segments[0] === ".agents") && segments[1] === "skills";
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
    return validateZcodeNativeDialect({
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

function isPortableZcodeSkill(value: SkillTypeDataV2): boolean {
    return (
        value.schemaVersion === 2 &&
        value.name.trim() !== "" &&
        value.description.trim() !== "" &&
        (value.whenToUse === "" || value.whenToUse === value.description) &&
        value.name.length <= 256 &&
        value.description.length <= 4096 &&
        value.invocation.pathCondition.mode === "none" &&
        value.invocation.user.mode === "direct" &&
        value.invocation.user.commandName === value.name &&
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

function validateCanonicalZcodeSkillEntry(input: CanonicalRenderEntryValidationInput, spec: SkillVariantSpec): boolean {
    if (
        input.canonical.kind !== "Skill" ||
        input.nativeDialectId !== ZCODE_NATIVE_DIALECTS.skill ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text" ||
        input.targetScope !== spec.scope ||
        !isPortableZcodeSkill(input.canonical.typeData)
    )
        return false;
    const boundary = replaceFixtureBoundary(spec.targetBoundary, input.targetVersion.assetId.slice(0, 8));
    if (input.nativeEntry.relativePath !== `${boundary}/${ENTRY_NAME}`) return false;
    const data = input.canonical.typeData;
    const parsed = parseZcodeFrontmatter(input.nativeEntry.content.text);
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
