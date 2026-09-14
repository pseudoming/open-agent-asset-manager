/** One-file foreign Markdown Workflow conversion; shared command directories are never owned. */
import { defineDialectComponentV1 as component, sha256SourceBytes, stableSourceValueEqual } from "@oaam/adapter-framework";
import {
    createNativeGlobalExactGraphProviderSupport,
    createNativeProjectExactGraphProviderSupport,
    createVerifiedNativeGlobalExactGraphBuild,
    createVerifiedNativeProjectExactGraphBuild,
    type AgentRuntimeDescriptor,
    type CanonicalMaterializationAssessmentInput,
    type CanonicalRenderEntryValidationInput,
    type NativeProjectExactGraphCanonicalMaterializer,
    type NativeProjectExactGraphCanonicalMaterializationInput,
    type PosixRelativePath,
    type RenderNativeRepresentationFileInput,
    type WorkflowTypeDataV2,
} from "@oaam/core/adapter-spi";
import { containsExecutablePromptSubstitution, parseClaudeFrontmatter } from "./claudecode-frontmatter";
import { CLAUDECODE_NATIVE_DIALECTS } from "./claudecode-source-read-model";
import { claudeCodeTargetBuildCompatibilityFor } from "./claudecode-target-build-compatibility";
import { CLAUDECODE_EXACT_TARGET_COMPONENTS, claudeCodeProjectWorkflowSpec } from "./claudecode-target-exact-file";
import {
    claudeCodeGlobalWorkflowSpec,
    materializeClaudeCodeNativeDocumentParent,
    parseChangedClaudeCodeNativeDocument,
    splitClaudeCodeNativeDocument,
} from "./claudecode-target-global-native-document";

type Scope = "project" | "global";
type RuntimeId = "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP";
const NATIVE = CLAUDECODE_NATIVE_DIALECTS.commandWorkflow;
const SOURCE = "antigravity-workflow-markdown-v1";

export function createClaudeWorkflowCanonicalSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    cliProjectSchema: string;
    appProjectSchema: string;
    cliGlobalSchema: string;
    appGlobalSchema: string;
}) {
    const make = (agentRuntimeId: RuntimeId, scope: Scope, targetContextSchemaId: string) => {
        const original =
            scope === "project" ? claudeCodeProjectWorkflowSpec(agentRuntimeId) : claudeCodeGlobalWorkflowSpec(agentRuntimeId);
        const materializationProfileId = original.materializationProfileId + "-canonical-v1";
        const graph = component("claudecode." + scope + "-workflow-reviewed-graph-v1");
        const { reverse, rebase } = CLAUDECODE_EXACT_TARGET_COMPONENTS.Workflow;
        const canonicalMaterializer = createClaudeWorkflowCanonicalMaterializer(scope);
        const canonicalMaterialization = {
            materializer: canonicalMaterializer.ref,
            degradationKinds: [...canonicalMaterializer.degradationKinds] as typeof canonicalMaterializer.degradationKinds,
            reasonCode: canonicalMaterializer.reasonCode,
            preservationDialectIds: [SOURCE],
            assessesLoss: true as const,
            requiresNativeSourceAssessment: true as const,
        };
        const build = {
            agentRuntimeId,
            versionText: original.versionText,
            buildIdentity: original.buildIdentity,
            platform: original.platform,
            materializationProfileId,
            fixtureId: original.fixtureId,
            assetKind: "Workflow" as const,
            nativeDialectId: NATIVE,
            reverseParser: reverse,
            rebaseMaterializer: rebase,
            canonicalMaterialization,
            restorationDialectIds: [],
            parentRebaseFixtureId: original.parentRebaseFixtureId,
            targetGraphIdentity: original.targetRelativePath,
            targetRelativePaths: [original.targetRelativePath],
            exactLoadMarker: original.exactLoadMarker,
            reverseFixtureId: original.reverseFixtureId,
        };
        const common = {
            adapterId: "CLAUDECODE" as const,
            adapterVersion: input.adapterVersion,
            agentRuntimes: input.agentRuntimes,
            agentRuntimeId,
            assetKind: "Workflow" as const,
            nativeDialectId: NATIVE,
            outputContractId: original.outputContractId + "_CANONICAL_V1",
            materializationProfileId,
            materializerCapabilityKey: "claudecode." + agentRuntimeId.toLowerCase() + "-" + scope + "-workflow-canonical-v1",
            reverseParser: {
                ref: reverse,
                parse: (value: Parameters<typeof parseChangedClaudeCodeNativeDocument>[0]) =>
                    validPath(value.relativePath, scope)
                        ? parseChangedClaudeCodeNativeDocument(value, { assetKind: "Workflow", nativeDialectId: NATIVE }, scope)
                        : null,
            },
            canonicalMaterializer,
            rebaseMaterializer: {
                ref: rebase,
                materialize: (value: Parameters<typeof materializeClaudeCodeNativeDocumentParent>[0]) =>
                    materializeClaudeCodeNativeDocumentParent(value, { assetKind: "Workflow", nativeDialectId: NATIVE }, scope),
            },
            restorationDialectIds: [],
            buildCompatibility: claudeCodeTargetBuildCompatibilityFor(agentRuntimeId),
            target: { targetContextSchemaId, requiredFacts: {} },
        };
        return scope === "project"
            ? createNativeProjectExactGraphProviderSupport({
                  ...common,
                  projectGraphValidator: { ref: graph, project: (files) => projectGraph(files, scope) },
                  verifiedBuilds: [createVerifiedNativeProjectExactGraphBuild({ ...build, projectGraphValidator: graph })],
              })
            : createNativeGlobalExactGraphProviderSupport({
                  ...common,
                  globalGraphValidator: { ref: graph, validate: (files) => projectGraph(files, scope) },
                  verifiedBuilds: [createVerifiedNativeGlobalExactGraphBuild({ ...build, globalGraphValidator: graph })],
              });
    };
    return {
        project: make("CLAUDE_CODE_CLI", "project", input.cliProjectSchema),
        global: make("CLAUDE_CODE_CLI", "global", input.cliGlobalSchema),
        appProject: make("CLAUDE_CODE_APP", "project", input.appProjectSchema),
        appGlobal: make("CLAUDE_CODE_APP", "global", input.appGlobalSchema),
    };
}

export function createClaudeWorkflowCanonicalMaterializer(scope: Scope): NativeProjectExactGraphCanonicalMaterializer {
    return {
        ref: component("claudecode." + scope + "-workflow-reviewed-canonical-materialization-v1"),
        degradationKinds: ["runtime_specific_metadata_lost"],
        preservationDialectIds: [SOURCE],
        requiresNativeSourceAssessment: true,
        reasonCode: "claudecode_workflow_canonical_conversion",
        diagnosticMessage: "The Markdown command preserves its instruction text and explicit user/model invocation.",
        assessLoss: (value) => assessment(value, scope),
        materialize: (value) => materialize(value, scope),
        validateEntry: (value) => validateEntry(value, scope),
    };
}

function expressible(data: WorkflowTypeDataV2): boolean {
    const implementation = data.implementation;
    return (
        data.schemaVersion === 2 &&
        /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(data.name) &&
        data.description.trim() !== "" &&
        implementation.kind === "instructions" &&
        [SOURCE, NATIVE].includes(implementation.instructionDialectId) &&
        implementation.execution.mode === "caller" &&
        implementation.execution.agent.mode === "agent_runtime_default" &&
        implementation.execution.model.mode === "inherit" &&
        implementation.execution.effort.mode === "inherit" &&
        implementation.execution.shell.mode === "none" &&
        implementation.toolPolicy.preapproved.length === 0 &&
        implementation.toolPolicy.denied.length === 0 &&
        implementation.toolPolicy.otherwise === "inherit_agent_runtime_policy" &&
        data.invocation.commandNames.length === 1 &&
        data.invocation.commandNames[0] === data.name &&
        data.invocation.argumentNames.length === 0
    );
}
function assessment(input: CanonicalMaterializationAssessmentInput, scope: Scope): [] | null {
    if (
        input.targetScope !== scope ||
        input.nativeDialectId !== NATIVE ||
        input.canonical.kind !== "Workflow" ||
        input.canonicalEntry.contentKind !== "text" ||
        !expressible(input.canonical.typeData)
    )
        return null;
    const body = input.canonicalEntry.text,
        data = input.canonical.typeData;
    if (body.trim() === "" || containsExecutablePromptSubstitution(body)) return null;
    if (data.implementation.kind !== "instructions") return null;
    if (data.implementation.instructionDialectId !== NATIVE && /\$(?:ARGUMENTS|\d+|\{CLAUDE_[A-Z0-9_]+\})/u.test(body))
        return null;
    const seed = input.nativePreservationSeed;
    if (seed === undefined) return [];
    if (seed.representation.dialectId !== SOURCE || seed.files.length !== 1) return null;
    const entry = seed.files[0];
    if (entry?.contentKind !== "text" || entry.executable || !entry.relativePath.endsWith(".md")) return null;
    const parsed = parseClaudeFrontmatter(entry.text);
    if ((parsed.hasFrontmatter && !parsed.closed) || parsed.diagnostics.length || parsed.body !== body) return null;
    for (const [key, value] of Object.entries(parsed.values)) {
        if ((key !== "name" && key !== "description") || value !== data[key]) return null;
    }
    return [];
}
function filePath(name: string, scope: Scope): PosixRelativePath {
    return ((scope === "project" ? ".claude/commands/" : "commands/") + name + ".md") as PosixRelativePath;
}
function fields(data: WorkflowTypeDataV2) {
    return {
        name: data.name,
        description: data.description,
        "user-invocable": data.invocation.userInvocable,
        "disable-model-invocation": !data.invocation.agentInvocable,
        ...(data.invocation.argumentHint === "" ? {} : { "argument-hint": data.invocation.argumentHint }),
    };
}
function header(data: WorkflowTypeDataV2): string {
    return (
        "---\n" +
        Object.entries(fields(data))
            .map(([key, value]) => key + ": " + JSON.stringify(value))
            .join("\n") +
        "\n---\n"
    );
}
function materialize(input: NativeProjectExactGraphCanonicalMaterializationInput, scope: Scope) {
    if (
        input.assetKind !== "Workflow" ||
        input.targetCanonical.kind !== "Workflow" ||
        input.restorationInputs.length ||
        input.targetFiles.length !== 1
    )
        return null;
    const entry = input.targetFiles[0];
    if (
        entry?.contentKind !== "text" ||
        entry.file.role !== "entry" ||
        entry.file.logicalPath !== "WORKFLOW.md" ||
        entry.file.executable
    )
        return null;
    if (
        assessment(
            {
                canonical: input.targetCanonical,
                canonicalEntry: { contentKind: "text", text: entry.text },
                targetScope: input.targetScope,
                targetVersion: input.targetVersion,
                nativeDialectId: input.nativeDialectId,
                nativePreservationSeed: input.nativePreservationSeed,
            },
            scope,
        ) === null
    )
        return null;
    const text = header(input.targetCanonical.typeData) + entry.text,
        bytes = new TextEncoder().encode(text);
    return {
        nativeFiles: [
            {
                relativePath: filePath(input.targetCanonical.typeData.name, scope),
                contentKind: "text" as const,
                text,
                executable: false,
                mediaType: entry.file.mediaType,
                byteSize: bytes.length,
                contentHash: sha256SourceBytes(bytes),
            },
        ],
    };
}
function validateEntry(input: CanonicalRenderEntryValidationInput, scope: Scope): boolean {
    if (
        assessment(input, scope) === null ||
        input.canonical.kind !== "Workflow" ||
        input.nativeEntry.content.contentKind !== "text" ||
        input.canonicalEntry.contentKind !== "text"
    )
        return false;
    const parsed = parseClaudeFrontmatter(input.nativeEntry.content.text);
    return (
        input.nativeEntry.relativePath === filePath(input.canonical.typeData.name, scope) &&
        parsed.hasFrontmatter &&
        parsed.closed &&
        parsed.diagnostics.length === 0 &&
        stableSourceValueEqual(parsed.values, fields(input.canonical.typeData)) &&
        parsed.body === input.canonicalEntry.text
    );
}
function projectGraph(files: readonly RenderNativeRepresentationFileInput[], scope: Scope) {
    if (files.length !== 1) return null;
    const file = files[0];
    if (file?.contentKind !== "text" || !validPath(file.relativePath, scope) || splitClaudeCodeNativeDocument(file.text) === null)
        return null;
    return {
        graphIdentityRelativePath: file.relativePath,
        files: [{ nativeRelativePath: file.relativePath, canonicalLogicalPath: "WORKFLOW.md" as PosixRelativePath }],
        managedDirectoryBoundaries: [],
    };
}
function validPath(relativePath: string, scope: Scope): boolean {
    const prefix = scope === "project" ? ".claude/commands/" : "commands/";
    if (!relativePath.startsWith(prefix) || relativePath.includes("\0") || relativePath.includes("\\")) return false;
    const segments = relativePath.slice(prefix.length).split("/");
    const name = segments.at(-1) ?? "";
    return (
        name !== ".md" &&
        name.endsWith(".md") &&
        segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    );
}
