/** Codex user-global Guidance and custom-agent targets at the exact CODEX_HOME root. */

import {
    defineDialectComponentV1 as component,
    adapterOperationDiagnostic as diagnostic,
    sha256SourceBytes,
} from "@oaam/adapter-framework";
import {
    type AdapterRenderAnalysisResult,
    type AgentRuntimeDescriptor,
    createNativeGlobalExactGraphProviderSupport,
    createNativeGlobalGuidanceProviderSupport,
    createVerifiedNativeGlobalExactGraphBuild,
    createVerifiedNativeGlobalGuidanceBuild,
    type NativeGlobalExactGraphProviderSupport,
    type NativeProjectExactGraphRebaseInput,
    type PosixRelativePath,
    type RenderAnalysisInput,
    type RenderNativeRepresentationFileInput,
} from "@oaam/core/adapter-spi";
import { CODEX_CURRENT_BUILDS } from "./codex-runtime-builds";
import { isCanonicalNativeRelativePath } from "./codex-source-read-foundation";
import { CODEX_NATIVE_DIALECTS } from "./codex-source-read-model";
import { validateCodexNativeDialect } from "./codex-source-read-native";
import {
    projectCodexSubagentCanonical,
    rebaseCodexSubagentToml,
    reverseCodexSubagentInstruction,
} from "./codex-subagent-native-editor";
import { codexTargetBuildCompatibilityFor } from "./codex-target-build-compatibility";
import { CODEX_EXACT_TARGET_COMPONENTS } from "./codex-target-exact-file";

type CodexRuntime = "CODEX_CLI" | "CODEX_APP";

export interface CodexGlobalTargetSupports {
    guidance: ReturnType<typeof createNativeGlobalGuidanceProviderSupport>;
    subagent: NativeGlobalExactGraphProviderSupport;
}

interface GlobalTargetSpec {
    agentRuntimeId: CodexRuntime;
    versionText: string;
    buildIdentity: `sha256:${string}`;
    platform: "wsl" | "win32";
    targetContextSchemaId: string;
    outputPrefix: string;
    profilePrefix: string;
    capabilityPrefix: string;
    fixturePrefix: string;
}

const GLOBAL_GUIDANCE_PATH = "AGENTS.md" as PosixRelativePath;
const GLOBAL_SUBAGENT_PATH = "agents/oaam-phase54-global-subagent.toml" as PosixRelativePath;

export const CODEX_GLOBAL_SUBAGENT_TARGET_COMPONENTS = {
    graph: component("codex.global-subagent-one-file-exact-graph-v1"),
    reverse: component(`${CODEX_NATIVE_DIALECTS.subagent}.native-to-canonical-parser`),
    rebase: CODEX_EXACT_TARGET_COMPONENTS.Subagent.rebase,
} as const;

const RUNTIME_SPECS: Record<CodexRuntime, GlobalTargetSpec> = {
    CODEX_CLI: {
        agentRuntimeId: "CODEX_CLI",
        versionText: CODEX_CURRENT_BUILDS.CODEX_CLI.versionText,
        buildIdentity: CODEX_CURRENT_BUILDS.CODEX_CLI.buildIdentity,
        platform: CODEX_CURRENT_BUILDS.CODEX_CLI.platform,
        targetContextSchemaId: "CODEX_CLI_GLOBAL_CONFIG_TARGET_V1",
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
        targetContextSchemaId: "CODEX_APP_GLOBAL_CONFIG_TARGET_V1",
        outputPrefix: "CODEX_APP_NATIVE",
        profilePrefix: "codex-app",
        capabilityPrefix: "codex.app",
        fixturePrefix: CODEX_CURRENT_BUILDS.CODEX_APP.fixturePrefix,
    },
};

export function createCodexGlobalTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
}): Record<CodexRuntime, CodexGlobalTargetSupports> {
    return {
        CODEX_CLI: createRuntimeSupports(RUNTIME_SPECS.CODEX_CLI, input),
        CODEX_APP: createRuntimeSupports(RUNTIME_SPECS.CODEX_APP, input),
    };
}

export async function analyzeCodexScopeTargets(
    input: RenderAnalysisInput,
    project: { analyze(value: RenderAnalysisInput): AdapterRenderAnalysisResult | Promise<AdapterRenderAnalysisResult> },
    global: { analyze(value: RenderAnalysisInput): AdapterRenderAnalysisResult | Promise<AdapterRenderAnalysisResult> },
): Promise<AdapterRenderAnalysisResult> {
    const scopes = new Set(input.deployment.assets.map((asset) => asset.scope));
    if (scopes.size === 1 && scopes.has("project")) return project.analyze(input);
    if (scopes.size === 1 && scopes.has("global")) return global.analyze(input);
    const unavailable = diagnostic(
        "render",
        "codex_target_scope_ambiguous",
        "One Codex Deployment must contain assets from one exact project or Global scope",
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
    spec: GlobalTargetSpec,
    input: { adapterVersion: string; agentRuntimes: readonly AgentRuntimeDescriptor[] },
): CodexGlobalTargetSupports {
    const guidanceProfile = `${spec.profilePrefix}-global-guidance-v1`;
    const guidance = createNativeGlobalGuidanceProviderSupport({
        adapterId: "CODEX",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        outputContractId: `${spec.outputPrefix}_GLOBAL_GUIDANCE_V1`,
        materializationProfileId: guidanceProfile,
        materializerCapabilityKey: `${spec.capabilityPrefix}-global-guidance-native-v1`,
        target: {
            relativePath: GLOBAL_GUIDANCE_PATH,
            targetContextSchemaId: spec.targetContextSchemaId,
            requiredFacts: {},
        },
        buildCompatibility: codexTargetBuildCompatibilityFor(spec.agentRuntimeId),
        verifiedBuilds: [
            createVerifiedNativeGlobalGuidanceBuild({
                agentRuntimeId: spec.agentRuntimeId,
                versionText: spec.versionText,
                buildIdentity: spec.buildIdentity,
                platform: spec.platform,
                materializationProfileId: guidanceProfile,
                fixtureId: `${spec.fixturePrefix}-global-agents-md-2026-08-05`,
                targetRelativePath: GLOBAL_GUIDANCE_PATH,
                exactLoadMarker: `OAAM_PHASE54_${spec.agentRuntimeId}_GLOBAL_GUIDANCE`,
                reverseFixtureId: `${spec.fixturePrefix}-global-guidance-whole-file-reverse-v1`,
            }),
        ],
    });
    return { guidance, subagent: createGlobalSubagentSupport(spec, input) };
}

function createGlobalSubagentSupport(
    spec: GlobalTargetSpec,
    input: { adapterVersion: string; agentRuntimes: readonly AgentRuntimeDescriptor[] },
): NativeGlobalExactGraphProviderSupport {
    const profile = `${spec.profilePrefix}-global-subagent-one-file-v1`;
    const verifiedBuild = createVerifiedNativeGlobalExactGraphBuild({
        agentRuntimeId: spec.agentRuntimeId,
        versionText: spec.versionText,
        buildIdentity: spec.buildIdentity,
        platform: spec.platform,
        materializationProfileId: profile,
        fixtureId: `${spec.fixturePrefix}-global-subagent-one-file-2026-08-05`,
        assetKind: "Subagent",
        nativeDialectId: CODEX_NATIVE_DIALECTS.subagent,
        globalGraphValidator: CODEX_GLOBAL_SUBAGENT_TARGET_COMPONENTS.graph,
        reverseParser: CODEX_GLOBAL_SUBAGENT_TARGET_COMPONENTS.reverse,
        rebaseMaterializer: CODEX_GLOBAL_SUBAGENT_TARGET_COMPONENTS.rebase,
        restorationDialectIds: [],
        parentRebaseFixtureId: `${spec.fixturePrefix}-global-subagent-one-file-parent-rebase-v1`,
        targetGraphIdentity: GLOBAL_SUBAGENT_PATH,
        targetRelativePaths: [GLOBAL_SUBAGENT_PATH],
        exactLoadMarker: `OAAM_PHASE54_${spec.agentRuntimeId}_GLOBAL_SUBAGENT`,
        reverseFixtureId: `${spec.fixturePrefix}-global-subagent-one-file-reverse-v1`,
    });
    return createNativeGlobalExactGraphProviderSupport({
        adapterId: "CODEX",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: "Subagent",
        outputContractId: `${spec.outputPrefix}_GLOBAL_SUBAGENT_ONE_FILE_V1`,
        materializationProfileId: profile,
        materializerCapabilityKey: `${spec.capabilityPrefix}-global-subagent-exact-graph-v1`,
        nativeDialectId: CODEX_NATIVE_DIALECTS.subagent,
        globalGraphValidator: {
            ref: CODEX_GLOBAL_SUBAGENT_TARGET_COMPONENTS.graph,
            validate: projectGlobalSubagentGraph,
        },
        reverseParser: {
            ref: CODEX_GLOBAL_SUBAGENT_TARGET_COMPONENTS.reverse,
            parse: (parseInput) => {
                if (parseInput.appliedContent.contentKind !== "text" || parseInput.currentContent.contentKind !== "text") {
                    return null;
                }
                const canonical = reverseCodexSubagentInstruction(parseInput.appliedContent.text, parseInput.currentContent.text);
                return canonical === null ? null : { canonicalContent: { contentKind: "text", text: canonical } };
            },
        },
        rebaseMaterializer: {
            ref: CODEX_GLOBAL_SUBAGENT_TARGET_COMPONENTS.rebase,
            materialize: materializeGlobalSubagentParent,
        },
        restorationDialectIds: [],
        target: { targetContextSchemaId: spec.targetContextSchemaId, requiredFacts: {} },
        buildCompatibility: codexTargetBuildCompatibilityFor(spec.agentRuntimeId),
        verifiedBuilds: [verifiedBuild],
    });
}

function projectGlobalSubagentGraph(files: readonly RenderNativeRepresentationFileInput[]) {
    const file = files[0];
    if (files.length !== 1 || file?.contentKind !== "text" || !isGlobalSubagentPath(file.relativePath)) return null;
    return {
        graphIdentityRelativePath: file.relativePath,
        files: [{ nativeRelativePath: file.relativePath, canonicalLogicalPath: "instructions.json" as PosixRelativePath }],
        managedDirectoryBoundaries: [],
    };
}

function materializeGlobalSubagentParent(
    input: NativeProjectExactGraphRebaseInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    const parent = input.parent.files[0];
    const target = input.targetFiles[0];
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== CODEX_NATIVE_DIALECTS.subagent ||
        input.targetCanonical.kind !== "Subagent" ||
        input.restorationInputs.length !== 0 ||
        input.parent.files.length !== 1 ||
        input.targetFiles.length !== 1 ||
        parent?.contentKind !== "text" ||
        target?.contentKind !== "text" ||
        target.file.role !== "entry" ||
        target.file.logicalPath !== "instructions.json" ||
        !isGlobalSubagentPath(parent.relativePath)
    ) {
        return null;
    }
    const projected = projectCodexSubagentCanonical(input.targetCanonical, target.text);
    const nativeText = projected === null ? null : rebaseCodexSubagentToml(parent.text, projected);
    if (nativeText === null) return null;
    const nativeFile = textNativeFile(parent, nativeText);
    const representationFiles = [nativeDescriptor(nativeFile)];
    return validateCodexNativeDialect({
        canonical: input.targetCanonical,
        canonicalFiles: input.targetFiles,
        representation: { ...input.parent.representation, files: representationFiles },
        nativeFiles: [{ relativePath: nativeFile.relativePath, bytes: new TextEncoder().encode(nativeText) }],
    })
        ? { nativeFiles: [nativeFile] }
        : null;
}

function textNativeFile(parent: Extract<RenderNativeRepresentationFileInput, { contentKind: "text" }>, text: string) {
    const bytes = new TextEncoder().encode(text);
    return { ...parent, text, contentHash: sha256SourceBytes(bytes), byteSize: bytes.byteLength };
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

function isGlobalSubagentPath(relativePath: PosixRelativePath): boolean {
    if (!isCanonicalNativeRelativePath(relativePath)) return false;
    const segments = relativePath.split("/");
    return (
        segments.length === 2 && segments[0] === "agents" && (segments[1]?.endsWith(".toml") ?? false) && segments[1] !== ".toml"
    );
}
