/** Exact Antigravity App/IDE project/global Markdown Workflow targets. */

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
    type Platform,
    type PosixRelativePath,
    type RenderAnalysisInput,
    type RenderNativeRepresentationFileInput,
    type WorkflowTypeDataV2,
} from "@oaam/core/adapter-spi";
import { antigravityFrontmatterString, parseAntigravityFrontmatter } from "./antigravity-frontmatter";
import { ANTIGRAVITY_NATIVE_DIALECTS } from "./antigravity-source-read-model";
import { validateAntigravityNativeDialect } from "./antigravity-source-read-native";
import {
    ANTIGRAVITY_APP_TARGET_BUILD_COMPATIBILITY,
    ANTIGRAVITY_IDE_TARGET_BUILD_COMPATIBILITY,
} from "./antigravity-target-build-compatibility";

const ENTRY_NAME = "WORKFLOW.md" as PosixRelativePath;
const PROJECT_FACTS = { "oaam.project-binding": "registered" } as const;
interface WorkflowRuntimeSpec {
    agentRuntimeId: AgentRuntimeId;
    profilePrefix: string;
    capabilityPrefix: string;
    outputPrefix: string;
    projectFixtureName: string;
    globalFixtureName: string;
    projectLoadMarker: string;
    globalLoadMarker: string;
    buildCompatibility: AdapterTargetBuildCompatibilityPolicyV1;
    builds: readonly {
        versionText: string;
        buildIdentity: `sha256:${string}`;
        platform: Platform;
        fixturePrefix: string;
    }[];
}

const IDE_WORKFLOW_SPEC = {
    agentRuntimeId: "ANTIGRAVITY_IDE",
    profilePrefix: "antigravity-ide",
    capabilityPrefix: "antigravity.ide",
    outputPrefix: "ANTIGRAVITY_IDE",
    projectFixtureName: "oaam-phase55-ide-workflow",
    globalFixtureName: "oaam-phase55-ide-global-workflow",
    projectLoadMarker: "OAAM_PHASE55_IDE_PROJECT_WORKFLOW",
    globalLoadMarker: "OAAM_PHASE55_IDE_GLOBAL_WORKFLOW",
    buildCompatibility: ANTIGRAVITY_IDE_TARGET_BUILD_COMPATIBILITY,
    builds: [
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
} as const satisfies WorkflowRuntimeSpec;

const APP_WORKFLOW_SPEC = {
    agentRuntimeId: "ANTIGRAVITY_APP",
    profilePrefix: "antigravity-app",
    capabilityPrefix: "antigravity.app",
    outputPrefix: "ANTIGRAVITY_APP",
    projectFixtureName: "oaam-phase55-app-workflow",
    globalFixtureName: "oaam-phase55-app-global-workflow",
    projectLoadMarker: "OAAM_PHASE55_APP_PROJECT_WORKFLOW",
    globalLoadMarker: "OAAM_PHASE55_APP_GLOBAL_WORKFLOW",
    buildCompatibility: ANTIGRAVITY_APP_TARGET_BUILD_COMPATIBILITY,
    builds: [
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
} as const satisfies WorkflowRuntimeSpec;

export interface AntigravityIdeWorkflowTargetSupports {
    project: NativeProjectExactGraphProviderSupport;
    global: NativeGlobalExactGraphProviderSupport;
}

export const ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS = {
    project: component("antigravity.ide-project-workflow-markdown-graph-v1"),
    global: component("antigravity.ide-global-workflow-markdown-graph-v1"),
    reverse: component(`${ANTIGRAVITY_NATIVE_DIALECTS.workflow}.native-to-canonical-parser`),
    rebase: component("antigravity.ide-workflow-parent-native-rebase-v1"),
    canonical: component("antigravity.ide-workflow-reviewed-canonical-materialization-v1"),
} as const;

export const ANTIGRAVITY_WORKFLOW_REBASE_MATERIALIZER = {
    ref: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.rebase,
    materialize: materializeWorkflowParent,
};

export function createAntigravityIdeWorkflowTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
}): AntigravityIdeWorkflowTargetSupports {
    return createWorkflowTargetSupports(IDE_WORKFLOW_SPEC, input);
}

export function createAntigravityAppWorkflowTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
}): AntigravityIdeWorkflowTargetSupports {
    return createWorkflowTargetSupports(APP_WORKFLOW_SPEC, input);
}

function createWorkflowTargetSupports(
    spec: WorkflowRuntimeSpec,
    input: {
        adapterVersion: string;
        agentRuntimes: readonly AgentRuntimeDescriptor[];
        projectTargetContextSchemaId: string;
        globalTargetContextSchemaId: string;
    },
): AntigravityIdeWorkflowTargetSupports {
    const projectProfile = `${spec.profilePrefix}-project-workflow-markdown-v1`;
    const globalProfile = `${spec.profilePrefix}-global-workflow-markdown-v1`;
    const projectPath = `.agents/workflows/${spec.projectFixtureName}.md` as PosixRelativePath;
    const globalPath = `config/global_workflows/${spec.globalFixtureName}.md` as PosixRelativePath;
    const projectBuilds = spec.builds.map((build) =>
        createVerifiedNativeProjectExactGraphBuild({
            agentRuntimeId: spec.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: projectProfile,
            fixtureId: `${build.fixturePrefix}-project-workflow-markdown-2026-08-07`,
            assetKind: "Workflow",
            nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.workflow,
            projectGraphValidator: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.project,
            reverseParser: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.reverse,
            rebaseMaterializer: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: {
                materializer: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.canonical,
                degradationKinds: ["runtime_specific_metadata_lost"],
                reasonCode: "antigravity_ide_workflow_reviewed_canonical_conversion",
            },
            restorationDialectIds: [],
            parentRebaseFixtureId: `${build.fixturePrefix}-project-workflow-parent-rebase-v1`,
            targetGraphIdentity: projectPath,
            targetRelativePaths: [projectPath],
            exactLoadMarker: spec.projectLoadMarker,
            reverseFixtureId: `${build.fixturePrefix}-project-workflow-reverse-v1`,
        }),
    );
    const globalBuilds = spec.builds.map((build) =>
        createVerifiedNativeGlobalExactGraphBuild({
            agentRuntimeId: spec.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: globalProfile,
            fixtureId: `${build.fixturePrefix}-global-workflow-markdown-2026-08-07`,
            assetKind: "Workflow",
            nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.workflow,
            globalGraphValidator: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.global,
            reverseParser: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.reverse,
            rebaseMaterializer: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: {
                materializer: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.canonical,
                degradationKinds: ["runtime_specific_metadata_lost"],
                reasonCode: "antigravity_ide_workflow_reviewed_canonical_conversion",
            },
            restorationDialectIds: [],
            parentRebaseFixtureId: `${build.fixturePrefix}-global-workflow-parent-rebase-v1`,
            targetGraphIdentity: globalPath,
            targetRelativePaths: [globalPath],
            exactLoadMarker: spec.globalLoadMarker,
            reverseFixtureId: `${build.fixturePrefix}-global-workflow-reverse-v1`,
        }),
    );
    const common = {
        adapterId: "ANTIGRAVITY" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: "Workflow" as const,
        nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.workflow,
        reverseParser: {
            ref: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.reverse,
            parse: parseChangedWorkflow,
        },
        rebaseMaterializer: ANTIGRAVITY_WORKFLOW_REBASE_MATERIALIZER,
        canonicalMaterializer: ANTIGRAVITY_WORKFLOW_CANONICAL_MATERIALIZER,
        restorationDialectIds: [],
        buildCompatibility: spec.buildCompatibility,
    };
    return {
        project: createNativeProjectExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_NATIVE_PROJECT_WORKFLOW_MARKDOWN_V1`,
            materializationProfileId: projectProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-project-workflow-markdown-v1`,
            projectGraphValidator: {
                ref: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.project,
                project: (files) => projectWorkflowGraph(files, "project"),
            },
            target: { targetContextSchemaId: input.projectTargetContextSchemaId, requiredFacts: PROJECT_FACTS },
            verifiedBuilds: projectBuilds,
        }),
        global: createNativeGlobalExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_NATIVE_GLOBAL_WORKFLOW_MARKDOWN_V1`,
            materializationProfileId: globalProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-global-workflow-markdown-v1`,
            globalGraphValidator: {
                ref: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.global,
                validate: (files) => projectWorkflowGraph(files, "global"),
            },
            target: { targetContextSchemaId: input.globalTargetContextSchemaId, requiredFacts: {} },
            verifiedBuilds: globalBuilds,
        }),
    };
}

const ANTIGRAVITY_WORKFLOW_CANONICAL_MATERIALIZER: NativeProjectExactGraphCanonicalMaterializer = {
    ref: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.canonical,
    degradationKinds: ["runtime_specific_metadata_lost"],
    reasonCode: "antigravity_ide_workflow_reviewed_canonical_conversion",
    diagnosticMessage:
        "OAAM can write the portable Workflow instructions, but source-runtime private metadata has no Antigravity equivalent",
    materialize: materializeCanonicalWorkflow,
    validateEntry: validateCanonicalWorkflowEntry,
};

function validateCanonicalWorkflowEntry(input: CanonicalRenderEntryValidationInput): boolean {
    if (
        input.canonical.kind !== "Workflow" ||
        input.nativeDialectId !== ANTIGRAVITY_NATIVE_DIALECTS.workflow ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text" ||
        !isPortableWorkflowSemantics(input.canonical.typeData, input.canonicalEntry.text)
    )
        return false;
    const data = input.canonical.typeData;
    if (
        input.nativeEntry.relativePath !==
        `${input.targetScope === "project" ? ".agents/workflows/" : "config/global_workflows/"}oaam-workflow-${input.targetVersion.assetId.slice(0, 8)}.md`
    )
        return false;
    const expected = { name: data.name, description: data.description };
    const parsed = parseAntigravityFrontmatter(input.nativeEntry.content.text);
    return (
        parsed.hasFrontmatter &&
        parsed.closed &&
        parsed.diagnostics.length === 0 &&
        parsed.body === input.canonicalEntry.text &&
        stableSourceValueEqual(parsed.values, expected)
    );
}

function materializeCanonicalWorkflow(
    input: NativeProjectExactGraphCanonicalMaterializationInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    const validated = portableWorkflow(input.targetCanonical, input.targetFiles);
    if (
        input.assetKind !== "Workflow" ||
        input.nativeDialectId !== ANTIGRAVITY_NATIVE_DIALECTS.workflow ||
        input.restorationInputs.length !== 0 ||
        validated === null
    ) {
        return null;
    }
    const name = `oaam-workflow-${input.targetVersion.assetId.slice(0, 8)}`;
    const relativePath =
        input.targetScope === "project"
            ? (`.agents/workflows/${name}.md` as PosixRelativePath)
            : (`config/global_workflows/${name}.md` as PosixRelativePath);
    const text = [
        "---",
        `name: ${JSON.stringify(validated.typeData.name)}`,
        `description: ${JSON.stringify(validated.typeData.description)}`,
        "---",
        validated.entry.text,
    ].join("\n");
    const bytes = new TextEncoder().encode(text);
    return {
        nativeFiles: [
            {
                relativePath,
                contentKind: "text",
                mediaType: validated.entry.file.mediaType,
                executable: false,
                contentHash: sha256SourceBytes(bytes),
                byteSize: bytes.byteLength,
                text,
            },
        ],
    };
}

function portableWorkflow(
    canonical: NativeProjectExactGraphCanonicalMaterializationInput["targetCanonical"],
    files: NativeProjectExactGraphCanonicalMaterializationInput["targetFiles"],
): {
    typeData: WorkflowTypeDataV2;
    entry: Extract<(typeof files)[number], { contentKind: "text" }>;
} | null {
    if (canonical.kind !== "Workflow" || files.length !== 1) return null;
    const entry = files[0];
    const typeData = canonical.typeData;
    if (
        entry?.contentKind !== "text" ||
        entry.file.role !== "entry" ||
        entry.file.logicalPath !== ENTRY_NAME ||
        entry.file.executable ||
        !isPortableWorkflowSemantics(typeData, entry.text)
    ) {
        return null;
    }
    return { typeData, entry };
}

function isPortableWorkflowSemantics(
    typeData: WorkflowTypeDataV2,
    body: string,
): typeData is WorkflowTypeDataV2 & {
    implementation: Extract<WorkflowTypeDataV2["implementation"], { kind: "instructions" }>;
} {
    const implementation = typeData.implementation;
    if (
        body.trim() === "" ||
        typeData.name.trim() === "" ||
        typeData.description.trim() === "" ||
        implementation.kind !== "instructions" ||
        implementation.execution.mode !== "caller" ||
        implementation.execution.agent.mode !== "agent_runtime_default" ||
        implementation.execution.model.mode !== "inherit" ||
        implementation.execution.effort.mode !== "inherit" ||
        implementation.execution.shell.mode !== "none" ||
        implementation.toolPolicy.preapproved.length !== 0 ||
        implementation.toolPolicy.denied.length !== 0 ||
        implementation.toolPolicy.otherwise !== "inherit_agent_runtime_policy" ||
        typeData.invocation.argumentHint !== "" ||
        typeData.invocation.argumentNames.length !== 0
    )
        return false;
    return true;
}

export async function analyzeAntigravityIdeWorkflowTargets(
    input: RenderAnalysisInput,
    supports: AntigravityIdeWorkflowTargetSupports,
): Promise<AdapterRenderAnalysisResult> {
    const support = selectAntigravityIdeWorkflowTargetSupport(input, supports);
    if (support !== null) return support.analyze(input);
    const issue = diagnostic(
        "render",
        "antigravity_ide_workflow_target_shape_ambiguous",
        "One Antigravity IDE Workflow Deployment must use one exact Project or Global Markdown lineage",
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

export async function analyzeAntigravityAppWorkflowTargets(
    input: RenderAnalysisInput,
    supports: AntigravityIdeWorkflowTargetSupports,
): Promise<AdapterRenderAnalysisResult> {
    const support = selectAntigravityIdeWorkflowTargetSupport(input, supports);
    if (support !== null) return support.analyze(input);
    const issue = diagnostic(
        "render",
        "antigravity_app_workflow_target_shape_ambiguous",
        "One Antigravity App Workflow Deployment must use one exact Project or Global Markdown lineage",
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

export function selectAntigravityIdeWorkflowTargetSupport(
    input: RenderAnalysisInput,
    supports: AntigravityIdeWorkflowTargetSupports,
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
    if (scopes.size !== 1 || dialects.size !== 1 || !dialects.has(ANTIGRAVITY_NATIVE_DIALECTS.workflow)) return null;
    if (scopes.has("project")) return supports.project;
    if (scopes.has("global")) return supports.global;
    return null;
}

function projectWorkflowGraph(files: readonly RenderNativeRepresentationFileInput[], scope: "project" | "global") {
    if (files.length !== 1) return null;
    const file = files[0];
    if (file?.contentKind !== "text" || !isWorkflowPath(file.relativePath, scope) || splitWorkflowDocument(file.text) === null) {
        return null;
    }
    return {
        graphIdentityRelativePath: file.relativePath,
        files: [{ nativeRelativePath: file.relativePath, canonicalLogicalPath: ENTRY_NAME }],
        managedDirectoryBoundaries: [],
    };
}

function materializeWorkflowParent(
    input: NativeProjectExactGraphRebaseInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (
        input.assetKind !== "Workflow" ||
        input.nativeDialectId !== ANTIGRAVITY_NATIVE_DIALECTS.workflow ||
        input.targetCanonical.kind !== "Workflow" ||
        input.restorationInputs.length !== 0 ||
        input.parent.files.length !== 1 ||
        input.targetFiles.length !== 1
    ) {
        return null;
    }
    const parent = input.parent.files[0];
    const target = input.targetFiles[0];
    if (
        parent?.contentKind !== "text" ||
        target?.contentKind !== "text" ||
        target.file.role !== "entry" ||
        target.file.logicalPath !== ENTRY_NAME ||
        (projectWorkflowGraph(input.parent.files, "project") === null &&
            projectWorkflowGraph(input.parent.files, "global") === null)
    ) {
        return null;
    }
    const parsed = splitWorkflowDocument(parent.text);
    const { text: parentText, ...descriptor } = parent;
    if (
        parsed === null ||
        !validateAntigravityNativeDialect({
            canonical: input.targetCanonical,
            canonicalFiles: [{ ...target, text: parsed.body }],
            representation: { ...input.parent.representation, files: [descriptor] },
            nativeFiles: [{ relativePath: parent.relativePath, bytes: new TextEncoder().encode(parentText) }],
        })
    ) {
        return null;
    }
    const text = `${parsed.prefix}${target.text}`;
    const bytes = new TextEncoder().encode(text);
    return {
        nativeFiles: [
            {
                relativePath: parent.relativePath,
                contentKind: "text",
                mediaType: target.file.mediaType,
                executable: target.file.executable,
                contentHash: sha256SourceBytes(bytes),
                byteSize: bytes.byteLength,
                text,
            },
        ],
    };
}

function parseChangedWorkflow(input: {
    assetKind: "Rule" | "Workflow" | "Skill" | "Subagent";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}) {
    if (
        input.assetKind !== "Workflow" ||
        input.nativeDialectId !== ANTIGRAVITY_NATIVE_DIALECTS.workflow ||
        input.appliedContent.contentKind !== "text" ||
        input.currentContent.contentKind !== "text" ||
        (!isWorkflowPath(input.relativePath, "project") && !isWorkflowPath(input.relativePath, "global"))
    ) {
        return null;
    }
    const applied = splitWorkflowDocument(input.appliedContent.text);
    const current = splitWorkflowDocument(input.currentContent.text);
    return applied === null || current === null || applied.prefix !== current.prefix
        ? null
        : { canonicalContent: { contentKind: "text" as const, text: current.body } };
}

function splitWorkflowDocument(nativeText: string): { prefix: string; body: string } | null {
    const parsed = parseAntigravityFrontmatter(nativeText);
    const allowed = new Set(["description", "name"]);
    if (
        !parsed.hasFrontmatter ||
        !parsed.closed ||
        parsed.diagnostics.length !== 0 ||
        parsed.body.trim() === "" ||
        parsed.presentKeys.some((key) => !allowed.has(key)) ||
        (antigravityFrontmatterString(parsed, "description") ?? "").trim() === ""
    ) {
        return null;
    }
    return { prefix: nativeText.slice(0, nativeText.length - parsed.body.length), body: parsed.body };
}

function isWorkflowPath(relativePath: PosixRelativePath, scope: "project" | "global"): boolean {
    if (relativePath.includes("\0") || relativePath.includes("\\") || !relativePath.endsWith(".md")) return false;
    const segments = relativePath.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
    return scope === "project"
        ? segments.length >= 3 && segments[0] === ".agents" && segments[1] === "workflows"
        : segments.length >= 3 && segments[0] === "config" && segments[1] === "global_workflows";
}
