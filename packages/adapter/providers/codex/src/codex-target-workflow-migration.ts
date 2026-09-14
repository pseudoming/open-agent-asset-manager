/** Reviewed Codex Workflow-to-Skill target migration for exact CLI/App builds. */

import {
    defineDialectComponentV1 as component,
    adapterOperationDiagnostic as diagnostic,
    sha256SourceBytes,
    stableSourceValueEqual,
} from "@oaam/adapter-framework";
import {
    type AdapterRenderAnalysisResult,
    type CanonicalRenderEntryValidationInput,
    type AgentRuntimeDescriptor,
    createNativeGlobalExactGraphProviderSupport,
    createNativeProjectExactGraphProviderSupport,
    createVerifiedNativeGlobalExactGraphBuild,
    createVerifiedNativeProjectExactGraphBuild,
    type NativeDialectValidationInputV1,
    type NativeGlobalExactGraphProviderSupport,
    type NativeProjectExactGraphCanonicalMaterializationInput,
    type NativeProjectExactGraphCanonicalMaterializer,
    type NativeProjectExactGraphProviderSupport,
    type NativeProjectExactGraphRebaseInput,
    type NativeProjectExactGraphRebaseMaterializer,
    type PosixRelativePath,
    type RenderAnalysisInput,
    type RenderNativeRepresentationFileInput,
    type WorkflowTypeDataV2,
} from "@oaam/core/adapter-spi";
import { frontmatterString, parseCodexFrontmatter } from "./codex-frontmatter";
import { CODEX_CURRENT_BUILDS } from "./codex-runtime-builds";
import { isCanonicalNativeRelativePath } from "./codex-source-read-foundation";
import { CODEX_NATIVE_DIALECTS } from "./codex-source-read-model";
import { customPromptArguments } from "./codex-source-read-workflow";
import { codexTargetBuildCompatibilityFor } from "./codex-target-build-compatibility";

type CodexRuntime = "CODEX_CLI" | "CODEX_APP";
type RuntimeSupports = Record<
    CodexRuntime,
    { project: NativeProjectExactGraphProviderSupport; global: NativeGlobalExactGraphProviderSupport }
>;

const ENTRY_NAME = "SKILL.md";
const CANONICAL_ENTRY = "WORKFLOW.md" as PosixRelativePath;
const DIRECTORY_TARGET_KIND_FACT = { "oaam.target-kind": "directory" } as const;
const DEGRADATION_KINDS = [
    "runtime_specific_metadata_lost",
    "target_runtime_missing_asset_kind",
    "workflow_trigger_lost",
] as const;
const REASON_CODE = "codex_workflow_converted_to_skill";

export const CODEX_WORKFLOW_MIGRATION_COMPONENTS = {
    project: component("codex.project-workflow-as-skill-graph-v1"),
    global: component("codex.global-workflow-as-skill-graph-v1"),
    reverse: component(`${CODEX_NATIVE_DIALECTS.workflowAsSkill}.native-to-canonical-parser`),
    rebase: component("codex.workflow-as-skill-parent-rebase-v1"),
    canonical: component("codex.workflow-as-skill-canonical-materializer-v1"),
} as const;

interface RuntimeSpec {
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

const RUNTIME_SPECS: Record<CodexRuntime, RuntimeSpec> = {
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

export function createCodexWorkflowMigrationTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
}): RuntimeSupports {
    return {
        CODEX_CLI: createRuntimeSupports(RUNTIME_SPECS.CODEX_CLI, input),
        CODEX_APP: createRuntimeSupports(RUNTIME_SPECS.CODEX_APP, input),
    };
}

export async function analyzeCodexWorkflowMigrationTargets(
    input: RenderAnalysisInput,
    supports: RuntimeSupports[CodexRuntime],
): Promise<AdapterRenderAnalysisResult> {
    const scopes = new Set(input.deployment.assets.map((asset) => asset.scope));
    if (scopes.size === 1 && scopes.has("project")) return supports.project.analyze(input);
    if (scopes.size === 1 && scopes.has("global")) return supports.global.analyze(input);
    const issue = diagnostic(
        "render",
        "codex_workflow_migration_scope_ambiguous",
        "One Codex Workflow migration must target one exact project or Global Skill root",
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

function createRuntimeSupports(
    spec: RuntimeSpec,
    input: { adapterVersion: string; agentRuntimes: readonly AgentRuntimeDescriptor[] },
): RuntimeSupports[CodexRuntime] {
    const canonicalDeclaration = {
        materializer: CODEX_WORKFLOW_MIGRATION_COMPONENTS.canonical,
        degradationKinds: [...DEGRADATION_KINDS] as [
            "runtime_specific_metadata_lost",
            "target_runtime_missing_asset_kind",
            "workflow_trigger_lost",
        ],
        substituteAssetKind: "Skill" as const,
        reasonCode: REASON_CODE,
    };
    const projectProfile = `${spec.profilePrefix}-project-workflow-as-skill-v1`;
    const globalProfile = `${spec.profilePrefix}-global-workflow-as-skill-v1`;
    const fixtureBoundary = "oaam-workflow-11111111";
    const projectPath = `.agents/skills/${fixtureBoundary}/${ENTRY_NAME}` as PosixRelativePath;
    const globalPath = `${fixtureBoundary}/${ENTRY_NAME}` as PosixRelativePath;
    const projectBuild = createVerifiedNativeProjectExactGraphBuild({
        agentRuntimeId: spec.agentRuntimeId,
        versionText: spec.versionText,
        buildIdentity: spec.buildIdentity,
        platform: spec.platform,
        materializationProfileId: projectProfile,
        fixtureId: `${spec.fixturePrefix}-project-workflow-as-skill-2026-08-06`,
        assetKind: "Workflow",
        nativeDialectId: CODEX_NATIVE_DIALECTS.workflowAsSkill,
        projectGraphValidator: CODEX_WORKFLOW_MIGRATION_COMPONENTS.project,
        reverseParser: CODEX_WORKFLOW_MIGRATION_COMPONENTS.reverse,
        rebaseMaterializer: CODEX_WORKFLOW_MIGRATION_COMPONENTS.rebase,
        canonicalMaterialization: canonicalDeclaration,
        restorationDialectIds: [],
        parentRebaseFixtureId: `${spec.fixturePrefix}-project-workflow-as-skill-parent-rebase-v1`,
        targetGraphIdentity: projectPath,
        targetRelativePaths: [projectPath],
        exactLoadMarker: `OAAM_PHASE54_${spec.agentRuntimeId}_PROJECT_WORKFLOW_AS_SKILL`,
        reverseFixtureId: `${spec.fixturePrefix}-project-workflow-as-skill-reverse-v1`,
    });
    const globalBuild = createVerifiedNativeGlobalExactGraphBuild({
        agentRuntimeId: spec.agentRuntimeId,
        versionText: spec.versionText,
        buildIdentity: spec.buildIdentity,
        platform: spec.platform,
        materializationProfileId: globalProfile,
        fixtureId: `${spec.fixturePrefix}-global-workflow-as-skill-2026-08-06`,
        assetKind: "Workflow",
        nativeDialectId: CODEX_NATIVE_DIALECTS.workflowAsSkill,
        globalGraphValidator: CODEX_WORKFLOW_MIGRATION_COMPONENTS.global,
        reverseParser: CODEX_WORKFLOW_MIGRATION_COMPONENTS.reverse,
        rebaseMaterializer: CODEX_WORKFLOW_MIGRATION_COMPONENTS.rebase,
        canonicalMaterialization: canonicalDeclaration,
        restorationDialectIds: [],
        parentRebaseFixtureId: `${spec.fixturePrefix}-global-workflow-as-skill-parent-rebase-v1`,
        targetGraphIdentity: globalPath,
        targetRelativePaths: [globalPath],
        exactLoadMarker: `OAAM_PHASE54_${spec.agentRuntimeId}_GLOBAL_WORKFLOW_AS_SKILL`,
        reverseFixtureId: `${spec.fixturePrefix}-global-workflow-as-skill-reverse-v1`,
    });
    const common = {
        adapterId: "CODEX" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: "Workflow" as const,
        nativeDialectId: CODEX_NATIVE_DIALECTS.workflowAsSkill,
        reverseParser: {
            ref: CODEX_WORKFLOW_MIGRATION_COMPONENTS.reverse,
            parse: parseChangedWorkflowSkillFile,
        },
        rebaseMaterializer: WORKFLOW_REBASE_MATERIALIZER,
        canonicalMaterializer: WORKFLOW_CANONICAL_MATERIALIZER,
        restorationDialectIds: [],
        buildCompatibility: codexTargetBuildCompatibilityFor(spec.agentRuntimeId),
    };
    return {
        project: createNativeProjectExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_PROJECT_WORKFLOW_AS_SKILL_V1`,
            materializationProfileId: projectProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-project-workflow-as-skill-v1`,
            projectGraphValidator: {
                ref: CODEX_WORKFLOW_MIGRATION_COMPONENTS.project,
                project: (files) => projectWorkflowSkillGraph(files, "project"),
            },
            target: { targetContextSchemaId: spec.projectTargetContextSchemaId, requiredFacts: {} },
            verifiedBuilds: [projectBuild],
        }),
        global: createNativeGlobalExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_GLOBAL_WORKFLOW_AS_SKILL_V1`,
            materializationProfileId: globalProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-global-workflow-as-skill-v1`,
            globalGraphValidator: {
                ref: CODEX_WORKFLOW_MIGRATION_COMPONENTS.global,
                validate: (files) => projectWorkflowSkillGraph(files, "global"),
            },
            target: {
                targetContextSchemaId: spec.globalTargetContextSchemaId,
                requiredFacts: DIRECTORY_TARGET_KIND_FACT,
            },
            verifiedBuilds: [globalBuild],
        }),
    };
}

const WORKFLOW_CANONICAL_MATERIALIZER: NativeProjectExactGraphCanonicalMaterializer = {
    ref: CODEX_WORKFLOW_MIGRATION_COMPONENTS.canonical,
    degradationKinds: [...DEGRADATION_KINDS],
    substituteAssetKind: "Skill",
    reasonCode: REASON_CODE,
    diagnosticMessage:
        "Codex no longer loads legacy Workflow files; OAAM will write this asset as a Skill after explicit degradation approval",
    materialize: materializeWorkflowAsSkill,
    validateEntry: validateCanonicalWorkflowEntry,
};

const WORKFLOW_REBASE_MATERIALIZER: NativeProjectExactGraphRebaseMaterializer = {
    ref: CODEX_WORKFLOW_MIGRATION_COMPONENTS.rebase,
    materialize: materializeWorkflowSkillParent,
};

function validateCanonicalWorkflowEntry(input: CanonicalRenderEntryValidationInput): boolean {
    if (
        input.canonical.kind !== "Workflow" ||
        input.nativeDialectId !== CODEX_NATIVE_DIALECTS.workflowAsSkill ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text" ||
        !isPortableWorkflowSemantics(input.canonical.typeData, input.canonicalEntry.text)
    )
        return false;
    const data = input.canonical.typeData;
    if (
        input.nativeEntry.relativePath !==
        `${input.targetScope === "project" ? ".agents/skills/" : ""}oaam-workflow-${input.targetVersion.assetId.slice(0, 8)}/${ENTRY_NAME}`
    )
        return false;
    const expected = { name: data.name, description: data.description.trim() || `Migrated OAAM Workflow ${data.name}` };
    const parsed = parseCodexFrontmatter(input.nativeEntry.content.text);
    return (
        parsed.hasFrontmatter &&
        parsed.closed &&
        parsed.diagnostics.length === 0 &&
        parsed.body === input.canonicalEntry.text &&
        stableSourceValueEqual(parsed.values, expected)
    );
}

function materializeWorkflowAsSkill(
    input: NativeProjectExactGraphCanonicalMaterializationInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    const validated = migratableWorkflow(input.targetCanonical, input.targetFiles);
    if (input.nativeDialectId !== CODEX_NATIVE_DIALECTS.workflowAsSkill || input.restorationInputs.length !== 0 || !validated) {
        return null;
    }
    const boundary = `oaam-workflow-${input.targetVersion.assetId.slice(0, 8)}`;
    const relativePath =
        input.targetScope === "project"
            ? (`.agents/skills/${boundary}/${ENTRY_NAME}` as PosixRelativePath)
            : (`${boundary}/${ENTRY_NAME}` as PosixRelativePath);
    return {
        nativeFiles: [workflowSkillNativeFile(relativePath, validated.typeData, validated.entry.text)],
    };
}

function materializeWorkflowSkillParent(
    input: NativeProjectExactGraphRebaseInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    const validated = migratableWorkflow(input.targetCanonical, input.targetFiles);
    if (
        input.nativeDialectId !== CODEX_NATIVE_DIALECTS.workflowAsSkill ||
        input.restorationInputs.length !== 0 ||
        !validated ||
        input.parent.files.length !== 1
    ) {
        return null;
    }
    const parent = input.parent.files[0];
    if (
        parent?.contentKind !== "text" ||
        projectWorkflowSkillGraph(input.parent.files, targetScopeForPath(parent.relativePath)) === null
    ) {
        return null;
    }
    return { nativeFiles: [workflowSkillNativeFile(parent.relativePath, validated.typeData, validated.entry.text)] };
}

function migratableWorkflow(
    canonical: NativeProjectExactGraphCanonicalMaterializationInput["targetCanonical"],
    files: NativeProjectExactGraphCanonicalMaterializationInput["targetFiles"],
): { typeData: WorkflowTypeDataV2; entry: Extract<(typeof files)[number], { contentKind: "text" }> } | null {
    if (canonical.kind !== "Workflow" || files.length !== 1) return null;
    const entry = files[0];
    const typeData = canonical.typeData;
    if (
        entry?.contentKind !== "text" ||
        entry.file.role !== "entry" ||
        entry.file.logicalPath !== CANONICAL_ENTRY ||
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
        implementation.kind !== "instructions" ||
        (implementation.instructionDialectId === CODEX_NATIVE_DIALECTS.workflow && customPromptArguments(body).length !== 0) ||
        (implementation.instructionDialectId === "claudecode-command-markdown-v1" && hasClaudeCommandPreprocessing(body)) ||
        implementation.execution.mode !== "caller" ||
        implementation.execution.agent.mode !== "agent_runtime_default" ||
        implementation.execution.model.mode !== "inherit" ||
        implementation.execution.effort.mode !== "inherit" ||
        (implementation.execution.shell.mode !== "none" &&
            !(
                implementation.instructionDialectId === "claudecode-command-markdown-v1" &&
                implementation.execution.shell.mode === "selected" &&
                implementation.execution.shell.dialectId === "claudecode-shell-selector-v1" &&
                implementation.execution.shell.selector === "bash"
            )) ||
        implementation.toolPolicy.preapproved.length !== 0 ||
        implementation.toolPolicy.denied.length !== 0 ||
        implementation.toolPolicy.otherwise !== "inherit_agent_runtime_policy" ||
        typeData.invocation.argumentHint !== "" ||
        typeData.invocation.argumentNames.length !== 0
    )
        return false;
    return true;
}

function hasClaudeCommandPreprocessing(text: string): boolean {
    // Source command syntax is retained literally; only static content has a reviewed Skill mapping.
    return (
        /\$ARGUMENTS/u.test(text) ||
        /\$\d+(?!\w)/u.test(text) ||
        /\$\{CLAUDE_(?:SKILL_DIR|SESSION_ID)\}/u.test(text) ||
        /```!\s*\n?[\s\S]*?\n?```/u.test(text) ||
        /(?:^|\s)!`[^`]+`/mu.test(text)
    );
}

function workflowSkillNativeFile(relativePath: PosixRelativePath, typeData: WorkflowTypeDataV2, body: string) {
    const description = typeData.description.trim() || `Migrated OAAM Workflow ${typeData.name}`;
    const text = [
        "---",
        `name: ${JSON.stringify(typeData.name)}`,
        `description: ${JSON.stringify(description)}`,
        "---",
        body,
    ].join("\n");
    const bytes = new TextEncoder().encode(text);
    return {
        relativePath,
        contentKind: "text" as const,
        mediaType: "text/markdown",
        executable: false,
        contentHash: sha256SourceBytes(bytes),
        byteSize: bytes.byteLength,
        text,
    };
}

function projectWorkflowSkillGraph(files: readonly RenderNativeRepresentationFileInput[], scope: "project" | "global") {
    if (files.length !== 1) return null;
    const file = files[0];
    if (file?.contentKind !== "text" || !isWorkflowSkillPath(file.relativePath, scope)) return null;
    return {
        graphIdentityRelativePath: file.relativePath,
        files: [{ nativeRelativePath: file.relativePath, canonicalLogicalPath: CANONICAL_ENTRY }],
        managedDirectoryBoundaries: [],
    };
}

function isWorkflowSkillPath(relativePath: string, scope: "project" | "global"): boolean {
    if (!isCanonicalNativeRelativePath(relativePath)) return false;
    const segments = relativePath.split("/");
    return scope === "project"
        ? segments.length === 4 &&
              segments[0] === ".agents" &&
              segments[1] === "skills" &&
              /^oaam-workflow-[0-9a-f]{8}$/.test(segments[2] ?? "") &&
              segments[3] === ENTRY_NAME
        : segments.length === 2 && /^oaam-workflow-[0-9a-f]{8}$/.test(segments[0] ?? "") && segments[1] === ENTRY_NAME;
}

function targetScopeForPath(relativePath: string): "project" | "global" {
    return relativePath.startsWith(".agents/skills/") ? "project" : "global";
}

function parseChangedWorkflowSkillFile(input: {
    assetKind: "Workflow";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}) {
    if (
        input.assetKind !== "Workflow" ||
        input.nativeDialectId !== CODEX_NATIVE_DIALECTS.workflowAsSkill ||
        input.appliedContent.contentKind !== "text" ||
        input.currentContent.contentKind !== "text"
    ) {
        return null;
    }
    const applied = splitWorkflowSkill(input.appliedContent.text);
    const current = splitWorkflowSkill(input.currentContent.text);
    return applied === null || current === null || applied.prefix !== current.prefix
        ? null
        : { canonicalContent: { contentKind: "text" as const, text: current.body } };
}

function splitWorkflowSkill(text: string): { prefix: string; body: string } | null {
    const parsed = parseCodexFrontmatter(text);
    if (!parsed.hasFrontmatter || !parsed.closed || parsed.diagnostics.length !== 0 || parsed.body.trim() === "") return null;
    return { prefix: text.slice(0, text.length - parsed.body.length), body: parsed.body };
}

export function validateCodexWorkflowAsSkillDialect(input: NativeDialectValidationInputV1): boolean {
    if (
        input.canonical.kind !== "Workflow" ||
        input.representation.schemaVersion !== 1 ||
        input.representation.dialectId !== CODEX_NATIVE_DIALECTS.workflowAsSkill ||
        input.nativeFiles.length !== 1 ||
        input.representation.files.length !== 1
    ) {
        return false;
    }
    const scope = targetScopeForPath(input.nativeFiles[0]?.relativePath ?? "");
    if (!isWorkflowSkillPath(input.nativeFiles[0]?.relativePath ?? "", scope)) return false;
    const validated = migratableWorkflow(input.canonical, input.canonicalFiles);
    const descriptor = input.representation.files[0];
    const native = input.nativeFiles[0];
    if (
        validated === null ||
        descriptor === undefined ||
        native === undefined ||
        descriptor.relativePath !== native.relativePath ||
        descriptor.contentKind !== "text" ||
        descriptor.mediaType !== "text/markdown" ||
        descriptor.executable ||
        descriptor.contentHash !== sha256SourceBytes(native.bytes) ||
        descriptor.byteSize !== native.bytes.byteLength
    ) {
        return false;
    }
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(native.bytes);
    } catch {
        return false;
    }
    const parsed = parseCodexFrontmatter(text);
    const expectedDescription = validated.typeData.description.trim() || `Migrated OAAM Workflow ${validated.typeData.name}`;
    return (
        parsed.hasFrontmatter &&
        parsed.closed &&
        parsed.diagnostics.length === 0 &&
        parsed.presentKeys.length === 2 &&
        parsed.presentKeys.includes("name") &&
        parsed.presentKeys.includes("description") &&
        frontmatterString(parsed, "name") === validated.typeData.name &&
        frontmatterString(parsed, "description") === expectedDescription &&
        parsed.body === validated.entry.text
    );
}
