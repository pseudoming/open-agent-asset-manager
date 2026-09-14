/** Antigravity CLI project/global Markdown Subagent targets over the exact graph contract. */

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
    type NativeProjectExactGraphCanonicalMaterializer,
    type NativeProjectExactGraphProviderSupport,
    type NativeProjectExactGraphRebaseInput,
    type NativeProjectExactGraphRebaseMaterializer,
    type Platform,
    type PosixRelativePath,
    type RenderAnalysisInput,
    type RenderNativeRepresentationFileInput,
} from "@oaam/core/adapter-spi";
import { parseAntigravityFrontmatter } from "./antigravity-frontmatter";
import { ANTIGRAVITY_NATIVE_DIALECTS } from "./antigravity-source-read-model";
import { validateAntigravityNativeDialect } from "./antigravity-source-read-native";
import {
    projectAntigravityMarkdownSubagentCanonical,
    rebaseAntigravityMarkdownSubagent,
    reverseAntigravityMarkdownSubagent,
    serializeAntigravityMarkdownSubagent,
} from "./antigravity-subagent-markdown";
import {
    ANTIGRAVITY_APP_SUBAGENT_TARGET_BUILD_COMPATIBILITY,
    ANTIGRAVITY_CLI_TARGET_BUILD_COMPATIBILITY,
} from "./antigravity-target-build-compatibility";

const PROJECT_TARGET_FACTS = { "oaam.project-binding": "registered" } as const;
const CANONICAL_DEGRADATIONS = ["runtime_specific_metadata_lost"] as const;

export interface AntigravitySubagentTargetSupports {
    project: NativeProjectExactGraphProviderSupport;
    global: NativeGlobalExactGraphProviderSupport;
}

interface SubagentRuntimeSpec {
    agentRuntimeId: AgentRuntimeId;
    profilePrefix: string;
    capabilityPrefix: string;
    outputPrefix: string;
    projectLoadMarker: string;
    globalLoadMarker: string;
    targetShape: "flat" | "folder";
    buildCompatibility: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: readonly {
        versionText: string;
        buildIdentity: `sha256:${string}`;
        platform: Platform;
        fixturePrefix: string;
    }[];
}

const CLI_SUBAGENT_SPEC = {
    agentRuntimeId: "ANTIGRAVITY_CLI",
    profilePrefix: "antigravity-cli",
    capabilityPrefix: "antigravity.cli",
    outputPrefix: "ANTIGRAVITY",
    projectLoadMarker: "OAAM_PHASE55_ANTIGRAVITY_PROJECT_SUBAGENT",
    globalLoadMarker: "OAAM_PHASE55_ANTIGRAVITY_GLOBAL_SUBAGENT",
    targetShape: "flat",
    buildCompatibility: ANTIGRAVITY_CLI_TARGET_BUILD_COMPATIBILITY,
    verifiedBuilds: [
        {
            versionText: "1.1.10",
            buildIdentity: "sha256:4217db798fd514cedce4e315013daea471a1a67666ab91547b2ad0dbee167a71",
            platform: "wsl",
            fixturePrefix: "antigravity-cli-1.1.10-wsl",
        },
    ],
} as const satisfies SubagentRuntimeSpec;

const APP_SUBAGENT_SPEC = {
    agentRuntimeId: "ANTIGRAVITY_APP",
    profilePrefix: "antigravity-app",
    capabilityPrefix: "antigravity.app",
    outputPrefix: "ANTIGRAVITY_APP",
    projectLoadMarker: "OAAM_PHASE59_APP_PROJECT_SUBAGENT",
    globalLoadMarker: "OAAM_PHASE59_APP_GLOBAL_SUBAGENT",
    targetShape: "folder",
    buildCompatibility: ANTIGRAVITY_APP_SUBAGENT_TARGET_BUILD_COMPATIBILITY,
    verifiedBuilds: [
        {
            versionText: "2.2.1",
            buildIdentity: "sha256:b0d127772d2983a93771055a93b673d5fdd1726d6e47db8e269b204e665972d6",
            platform: "wsl",
            fixturePrefix: "antigravity-app-2.2.1-wsl",
        },
        {
            versionText: "2.2.1",
            buildIdentity: "sha256:a106300d49a1f63b162d73d37ec3eec7ce06df0c6aa5d93e483fecb80785dd8e",
            platform: "win32",
            fixturePrefix: "antigravity-app-2.2.1-win32",
        },
    ],
} as const satisfies SubagentRuntimeSpec;

export const ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS = {
    project: component("antigravity.project-subagent-markdown-one-file-v1"),
    global: component("antigravity.global-subagent-markdown-one-file-v1"),
    reverse: component(`${ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown}.native-to-canonical-parser`),
    rebase: component("antigravity.subagent-markdown-parent-native-rebase-v1"),
    canonical: component("antigravity.subagent-markdown-reviewed-canonical-materialization-v1"),
} as const;

const REBASE_MATERIALIZER: NativeProjectExactGraphRebaseMaterializer = {
    ref: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.rebase,
    materialize: materializeParent,
};

export function createAntigravitySubagentTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
}): AntigravitySubagentTargetSupports {
    return createSubagentTargetSupports(CLI_SUBAGENT_SPEC, input);
}

export function createAntigravityAppSubagentTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
}): AntigravitySubagentTargetSupports {
    return createSubagentTargetSupports(APP_SUBAGENT_SPEC, input);
}

function createSubagentTargetSupports(
    spec: SubagentRuntimeSpec,
    input: {
        adapterVersion: string;
        agentRuntimes: readonly AgentRuntimeDescriptor[];
        projectTargetContextSchemaId: string;
        globalTargetContextSchemaId: string;
    },
): AntigravitySubagentTargetSupports {
    const projectProfile = `${spec.profilePrefix}-project-subagent-markdown-v1`;
    const globalProfile = `${spec.profilePrefix}-global-subagent-markdown-v1`;
    const canonicalDeclaration = {
        materializer: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.canonical,
        degradationKinds: [...CANONICAL_DEGRADATIONS] as ["runtime_specific_metadata_lost"],
        reasonCode: "antigravity_subagent_reviewed_canonical_conversion",
    };
    const projectPath = targetPath(
        spec,
        "project",
        spec.targetShape === "folder" ? "oaam-phase59-app-subagent" : "oaam-phase55-subagent",
    );
    const globalPath = targetPath(
        spec,
        "global",
        spec.targetShape === "folder" ? "oaam-phase59-app-global-subagent" : "oaam-phase55-global-subagent",
    );
    const projectBuilds = spec.verifiedBuilds.map((build) =>
        createVerifiedNativeProjectExactGraphBuild({
            agentRuntimeId: spec.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: projectProfile,
            fixtureId: `${build.fixturePrefix}-project-subagent-markdown-2026-08-07`,
            assetKind: "Subagent",
            nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown,
            projectGraphValidator: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.project,
            reverseParser: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.reverse,
            rebaseMaterializer: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: canonicalDeclaration,
            restorationDialectIds: [],
            parentRebaseFixtureId: `${build.fixturePrefix}-project-subagent-markdown-parent-rebase-v1`,
            targetGraphIdentity: projectPath,
            targetRelativePaths: [projectPath],
            exactLoadMarker: spec.projectLoadMarker,
            reverseFixtureId: `${build.fixturePrefix}-project-subagent-markdown-body-reverse-v1`,
        }),
    );
    const globalBuilds = spec.verifiedBuilds.map((build) =>
        createVerifiedNativeGlobalExactGraphBuild({
            agentRuntimeId: spec.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: globalProfile,
            fixtureId: `${build.fixturePrefix}-global-subagent-markdown-2026-08-07`,
            assetKind: "Subagent",
            nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown,
            globalGraphValidator: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.global,
            reverseParser: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.reverse,
            rebaseMaterializer: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: canonicalDeclaration,
            restorationDialectIds: [],
            parentRebaseFixtureId: `${build.fixturePrefix}-global-subagent-markdown-parent-rebase-v1`,
            targetGraphIdentity: globalPath,
            targetRelativePaths: [globalPath],
            exactLoadMarker: spec.globalLoadMarker,
            reverseFixtureId: `${build.fixturePrefix}-global-subagent-markdown-body-reverse-v1`,
        }),
    );
    const common = {
        adapterId: "ANTIGRAVITY" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: "Subagent" as const,
        nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown,
        reverseParser: {
            ref: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.reverse,
            parse: parseChangedFile,
        },
        rebaseMaterializer: REBASE_MATERIALIZER,
        canonicalMaterializer: canonicalMaterializerFor(spec),
        restorationDialectIds: [],
        buildCompatibility: spec.buildCompatibility,
    };
    return {
        project: createNativeProjectExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1`,
            materializationProfileId: projectProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-project-subagent-markdown-v1`,
            projectGraphValidator: {
                ref: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.project,
                project: (files) => projectOneFileGraph(files, "project"),
            },
            target: { targetContextSchemaId: input.projectTargetContextSchemaId, requiredFacts: PROJECT_TARGET_FACTS },
            verifiedBuilds: projectBuilds,
        }),
        global: createNativeGlobalExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1`,
            materializationProfileId: globalProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-global-subagent-markdown-v1`,
            globalGraphValidator: {
                ref: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.global,
                validate: (files) => projectOneFileGraph(files, "global"),
            },
            target: { targetContextSchemaId: input.globalTargetContextSchemaId, requiredFacts: {} },
            verifiedBuilds: globalBuilds,
        }),
    };
}

export async function analyzeAntigravitySubagentTargets(
    input: RenderAnalysisInput,
    supports: AntigravitySubagentTargetSupports,
): Promise<AdapterRenderAnalysisResult> {
    const support = selectAntigravitySubagentTargetSupport(input, supports);
    if (support !== null) return support.analyze(input);
    const issue = diagnostic(
        "render",
        "antigravity_subagent_target_shape_ambiguous",
        "One Antigravity Subagent Deployment must use one exact Project or Global scope and the Markdown declaration dialect",
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

export function selectAntigravitySubagentTargetSupport(
    input: RenderAnalysisInput,
    supports: AntigravitySubagentTargetSupports,
): NativeProjectExactGraphProviderSupport | NativeGlobalExactGraphProviderSupport | null {
    const scopes = new Set(input.deployment.assets.map((asset) => asset.scope));
    const dialects = new Set(
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
    if (dialects.size !== 1 || !dialects.has(ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown) || scopes.size !== 1) return null;
    if (scopes.has("project")) return supports.project;
    return scopes.has("global") ? supports.global : null;
}

function projectOneFileGraph(files: readonly RenderNativeRepresentationFileInput[], scope: "project" | "global") {
    const file = files[0];
    if (files.length !== 1 || file?.contentKind !== "text" || !isSubagentPath(file.relativePath, scope)) return null;
    return {
        graphIdentityRelativePath: file.relativePath,
        files: [{ nativeRelativePath: file.relativePath, canonicalLogicalPath: "instructions.json" as PosixRelativePath }],
        managedDirectoryBoundaries: [],
    };
}

function materializeParent(
    input: NativeProjectExactGraphRebaseInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    const parent = input.parent.files[0];
    const target = input.targetFiles[0];
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown ||
        input.targetCanonical.kind !== "Subagent" ||
        input.restorationInputs.length !== 0 ||
        input.parent.files.length !== 1 ||
        input.targetFiles.length !== 1 ||
        parent?.contentKind !== "text" ||
        target?.contentKind !== "text" ||
        target.file.role !== "entry" ||
        target.file.logicalPath !== "instructions.json" ||
        (!isSubagentPath(parent.relativePath, "project") && !isSubagentPath(parent.relativePath, "global"))
    ) {
        return null;
    }
    const projection = projectAntigravityMarkdownSubagentCanonical(input.targetCanonical, target.text);
    const nativeText = projection === null ? null : rebaseAntigravityMarkdownSubagent(parent.text, projection);
    if (nativeText === null) return null;
    const nativeFile = textNativeFile(parent.relativePath, nativeText, parent.mediaType, parent.executable);
    return validatesNative(input, nativeFile) ? { nativeFiles: [nativeFile] } : null;
}

function canonicalMaterializerFor(spec: SubagentRuntimeSpec): NativeProjectExactGraphCanonicalMaterializer {
    return {
        ref: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.canonical,
        degradationKinds: [...CANONICAL_DEGRADATIONS],
        reasonCode: "antigravity_subagent_reviewed_canonical_conversion",
        diagnosticMessage:
            "OAAM can map the portable Subagent fields, but source-runtime-only layout, comments and private syntax do not become Antigravity behavior",
        materialize: (input) => materializeCanonical(spec, input),
        validateEntry: (value) => validateCanonicalEntry(value, spec),
    };
}

function validateCanonicalEntry(input: CanonicalRenderEntryValidationInput, spec: SubagentRuntimeSpec): boolean {
    if (
        input.canonical.kind !== "Subagent" ||
        input.nativeDialectId !== ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text" ||
        input.nativeEntry.relativePath !==
            targetPath(spec, input.targetScope, `oaam-agent-${input.targetVersion.assetId.slice(0, 8)}`)
    )
        return false;
    const projection = projectAntigravityMarkdownSubagentCanonical(input.canonical, input.canonicalEntry.text);
    if (projection === null) return false;
    const expected = Object.fromEntries(
        Object.entries({
            name: projection.name,
            description: projection.description,
            subagent: true,
            tools: projection.tools,
            mainAgent: projection.mainAgent,
            model: projection.model,
            commandExecutionPolicy: projection.commandExecutionPolicy,
            hidden: projection.hidden,
        }).filter(([, value]) => value !== undefined),
    );
    const parsed = parseAntigravityFrontmatter(input.nativeEntry.content.text);
    return (
        parsed.hasFrontmatter &&
        parsed.closed &&
        parsed.diagnostics.length === 0 &&
        parsed.body === projection.body &&
        stableSourceValueEqual(parsed.values, expected)
    );
}

function materializeCanonical(
    spec: SubagentRuntimeSpec,
    input: Parameters<NativeProjectExactGraphCanonicalMaterializer["materialize"]>[0],
) {
    const entry = input.targetFiles[0];
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown ||
        input.targetCanonical.kind !== "Subagent" ||
        input.restorationInputs.length !== 0 ||
        input.targetFiles.length !== 1 ||
        entry?.contentKind !== "text" ||
        entry.file.role !== "entry" ||
        entry.file.logicalPath !== "instructions.json"
    ) {
        return null;
    }
    const projection = projectAntigravityMarkdownSubagentCanonical(input.targetCanonical, entry.text);
    if (projection === null) return null;
    const relativePath = targetPath(spec, input.targetScope, `oaam-agent-${input.targetVersion.assetId.slice(0, 8)}`);
    return {
        nativeFiles: [textNativeFile(relativePath, serializeAntigravityMarkdownSubagent(projection), "text/markdown", false)],
    };
}

function targetPath(spec: SubagentRuntimeSpec, scope: "project" | "global", name: string): PosixRelativePath {
    const root = scope === "project" ? ".agents/agents" : "config/agents";
    return `${root}/${name}${spec.targetShape === "folder" ? "/agent.md" : ".md"}` as PosixRelativePath;
}

function parseChangedFile(input: {
    assetKind: "Subagent";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}) {
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown ||
        input.appliedContent.contentKind !== "text" ||
        input.currentContent.contentKind !== "text"
    ) {
        return null;
    }
    const canonical = reverseAntigravityMarkdownSubagent(input.appliedContent.text, input.currentContent.text);
    return canonical === null ? null : { canonicalContent: { contentKind: "text" as const, text: canonical } };
}

function validatesNative(input: NativeProjectExactGraphRebaseInput, file: RenderNativeRepresentationFileInput): boolean {
    return validateAntigravityNativeDialect({
        canonical: input.targetCanonical,
        canonicalFiles: input.targetFiles,
        representation: { ...input.parent.representation, files: [nativeDescriptor(file)] },
        nativeFiles: [
            {
                relativePath: file.relativePath,
                bytes: file.contentKind === "text" ? new TextEncoder().encode(file.text) : new Uint8Array(file.bytes),
            },
        ],
    });
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

function isSubagentPath(relativePath: PosixRelativePath, scope: "project" | "global"): boolean {
    if (!isCanonicalRelativePath(relativePath)) return false;
    const segments = relativePath.split("/");
    const root = scope === "project" ? [".agents", "agents"] : ["config", "agents"];
    if (segments[0] !== root[0] || segments[1] !== root[1]) return false;
    return (
        (segments.length === 3 && segments[2] !== ".md" && (segments[2]?.endsWith(".md") ?? false)) ||
        (segments.length === 4 && segments[2] !== "" && segments[3] === "agent.md")
    );
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
