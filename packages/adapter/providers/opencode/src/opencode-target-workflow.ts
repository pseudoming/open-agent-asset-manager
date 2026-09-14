/** Exact OpenCode CLI/App project/global Markdown-command Workflow targets. */

import {
    adapterOperationDiagnostic as diagnostic,
    defineDialectComponentV1 as component,
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
    type NativeGlobalExactGraphProviderSupport,
    type NativeProjectExactGraphCanonicalMaterializationInput,
    type NativeProjectExactGraphCanonicalMaterializer,
    type NativeProjectExactGraphProviderSupport,
    type NativeProjectExactGraphRebaseInput,
    type PosixRelativePath,
    type RenderAnalysisInput,
    type RenderNativeRepresentationFileInput,
    type WorkflowTypeDataV2,
} from "@oaam/core/adapter-spi";
import { frontmatterBoolean, frontmatterString, parseOpencodeFrontmatter } from "./opencode-frontmatter";
import { commandArguments, containsShellSubstitution, parseOpenCodeAtReferenceTokens } from "./opencode-source-read-foundation";
import { unknownKeys } from "./opencode-source-read-fields";
import { MODEL_DIALECT, OPENCODE_NATIVE_DIALECTS, VARIANT_DIALECT } from "./opencode-source-read-model";
import { validateOpencodeNativeDialect } from "./opencode-source-read-native";
import {
    appendOpencodeBuildCompatibilityWarning,
    OPENCODE_TARGET_BUILD_COMPATIBILITY,
} from "./opencode-target-build-compatibility";
import {
    OPENCODE_APP_TARGET_BUILD_ANCHORS,
    OPENCODE_CLI_TARGET_BUILD_ANCHORS,
    type OpencodeTargetBuildAnchor,
} from "./opencode-target-builds";

const ENTRY_NAME = "WORKFLOW.md" as PosixRelativePath;
const GLOBAL_FACTS = { "oaam.target-kind": "global" } as const;
const ALLOWED_FRONTMATTER = ["description", "agent", "model", "variant", "subtask"] as const;

type OpenCodeWorkflowRuntimeId = "OPENCODE_CLI" | "OPENCODE_APP";

interface WorkflowRuntimeSpec {
    agentRuntimeId: OpenCodeWorkflowRuntimeId;
    profilePrefix: string;
    capabilityPrefix: string;
    outputPrefix: string;
    targetBuilds: readonly OpencodeTargetBuildAnchor[];
    projectFixtureName: string;
    globalFixtureName: string;
    projectLoadMarker: string;
    globalLoadMarker: string;
}

const CLI_SPEC = {
    agentRuntimeId: "OPENCODE_CLI",
    profilePrefix: "opencode-cli",
    capabilityPrefix: "opencode.cli",
    outputPrefix: "OPENCODE_CLI",
    targetBuilds: OPENCODE_CLI_TARGET_BUILD_ANCHORS,
    projectFixtureName: "oaam-phase57-current-loader",
    globalFixtureName: "oaam-phase57-global-workflow",
    projectLoadMarker: "oaam-phase57-current-loader",
    globalLoadMarker: "oaam-phase57-global-workflow",
} as const satisfies WorkflowRuntimeSpec;

const APP_SPEC = {
    agentRuntimeId: "OPENCODE_APP",
    profilePrefix: "opencode-app",
    capabilityPrefix: "opencode.app",
    outputPrefix: "OPENCODE_APP",
    targetBuilds: OPENCODE_APP_TARGET_BUILD_ANCHORS,
    projectFixtureName: "oaam-phase57-app-current-loader",
    globalFixtureName: "oaam-phase57-app-global-workflow",
    projectLoadMarker: "oaam-phase57-app-current-loader",
    globalLoadMarker: "oaam-phase57-app-global-workflow",
} as const satisfies WorkflowRuntimeSpec;

export interface OpencodeWorkflowTargetSupports {
    project: NativeProjectExactGraphProviderSupport;
    global: NativeGlobalExactGraphProviderSupport;
}

export const OPENCODE_WORKFLOW_TARGET_COMPONENTS = {
    project: component("opencode.project-command-workflow-one-file-v1"),
    global: component("opencode.global-command-workflow-one-file-v1"),
    reverse: component(`${OPENCODE_NATIVE_DIALECTS.commandWorkflow}.native-to-canonical-parser`),
    rebase: component("opencode.command-workflow-parent-native-rebase-v1"),
    canonical: component("opencode.command-workflow-reviewed-canonical-materialization-v1"),
} as const;

export function createOpencodeCliWorkflowTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
}): OpencodeWorkflowTargetSupports {
    return createWorkflowTargetSupports(CLI_SPEC, input);
}

export function createOpencodeAppWorkflowTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
}): OpencodeWorkflowTargetSupports {
    return createWorkflowTargetSupports(APP_SPEC, input);
}

function createWorkflowTargetSupports(
    spec: WorkflowRuntimeSpec,
    input: {
        adapterVersion: string;
        agentRuntimes: readonly AgentRuntimeDescriptor[];
        projectTargetContextSchemaId: string;
        globalTargetContextSchemaId: string;
    },
): OpencodeWorkflowTargetSupports {
    const projectProfile = `${spec.profilePrefix}-project-workflow-markdown-v1`;
    const globalProfile = `${spec.profilePrefix}-global-workflow-markdown-v1`;
    const projectPath = `.opencode/commands/${spec.projectFixtureName}.md` as PosixRelativePath;
    const globalPath = `commands/${spec.globalFixtureName}.md` as PosixRelativePath;
    const projectBuilds = spec.targetBuilds.map((build) =>
        createVerifiedNativeProjectExactGraphBuild({
            agentRuntimeId: spec.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: projectProfile,
            fixtureId: `${spec.profilePrefix}-1.18.15-${build.platform}-project-workflow-${build.fixtureDate}`,
            assetKind: "Workflow",
            nativeDialectId: OPENCODE_NATIVE_DIALECTS.commandWorkflow,
            projectGraphValidator: OPENCODE_WORKFLOW_TARGET_COMPONENTS.project,
            reverseParser: OPENCODE_WORKFLOW_TARGET_COMPONENTS.reverse,
            rebaseMaterializer: OPENCODE_WORKFLOW_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: canonicalMaterializationDeclaration(),
            restorationDialectIds: [],
            parentRebaseFixtureId: `${spec.profilePrefix}-1.18.15-${build.platform}-project-workflow-parent-rebase-v1`,
            targetGraphIdentity: projectPath,
            targetRelativePaths: [projectPath],
            exactLoadMarker: spec.projectLoadMarker,
            reverseFixtureId: `${spec.profilePrefix}-1.18.15-${build.platform}-project-workflow-reverse-v1`,
        }),
    );
    const globalBuilds = spec.targetBuilds.map((build) =>
        createVerifiedNativeGlobalExactGraphBuild({
            agentRuntimeId: spec.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: globalProfile,
            fixtureId: `${spec.profilePrefix}-1.18.15-${build.platform}-global-workflow-${build.fixtureDate}`,
            assetKind: "Workflow",
            nativeDialectId: OPENCODE_NATIVE_DIALECTS.commandWorkflow,
            globalGraphValidator: OPENCODE_WORKFLOW_TARGET_COMPONENTS.global,
            reverseParser: OPENCODE_WORKFLOW_TARGET_COMPONENTS.reverse,
            rebaseMaterializer: OPENCODE_WORKFLOW_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: canonicalMaterializationDeclaration(),
            restorationDialectIds: [],
            parentRebaseFixtureId: `${spec.profilePrefix}-1.18.15-${build.platform}-global-workflow-parent-rebase-v1`,
            targetGraphIdentity: globalPath,
            targetRelativePaths: [globalPath],
            exactLoadMarker: spec.globalLoadMarker,
            reverseFixtureId: `${spec.profilePrefix}-1.18.15-${build.platform}-global-workflow-reverse-v1`,
        }),
    );
    const common = {
        adapterId: "OPENCODE" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: "Workflow" as const,
        nativeDialectId: OPENCODE_NATIVE_DIALECTS.commandWorkflow,
        reverseParser: {
            ref: OPENCODE_WORKFLOW_TARGET_COMPONENTS.reverse,
            parse: parseChangedWorkflow,
        },
        rebaseMaterializer: {
            ref: OPENCODE_WORKFLOW_TARGET_COMPONENTS.rebase,
            materialize: materializeWorkflowParent,
        },
        canonicalMaterializer: OPENCODE_WORKFLOW_CANONICAL_MATERIALIZER,
        restorationDialectIds: [],
        buildCompatibility: OPENCODE_TARGET_BUILD_COMPATIBILITY,
    };
    return {
        project: createNativeProjectExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_NATIVE_PROJECT_WORKFLOW_MARKDOWN_V1`,
            materializationProfileId: projectProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-project-workflow-markdown-v1`,
            projectGraphValidator: {
                ref: OPENCODE_WORKFLOW_TARGET_COMPONENTS.project,
                project: (files) => workflowGraph(files, "project"),
            },
            target: { targetContextSchemaId: input.projectTargetContextSchemaId, requiredFacts: {} },
            verifiedBuilds: projectBuilds,
        }),
        global: createNativeGlobalExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_NATIVE_GLOBAL_WORKFLOW_MARKDOWN_V1`,
            materializationProfileId: globalProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-global-workflow-markdown-v1`,
            globalGraphValidator: {
                ref: OPENCODE_WORKFLOW_TARGET_COMPONENTS.global,
                validate: (files) => workflowGraph(files, "global"),
            },
            target: { targetContextSchemaId: input.globalTargetContextSchemaId, requiredFacts: GLOBAL_FACTS },
            verifiedBuilds: globalBuilds,
        }),
    };
}

function canonicalMaterializationDeclaration() {
    return {
        materializer: OPENCODE_WORKFLOW_TARGET_COMPONENTS.canonical,
        degradationKinds: ["runtime_specific_metadata_lost"] as ["runtime_specific_metadata_lost"],
        reasonCode: "opencode_workflow_reviewed_canonical_conversion",
    };
}

const OPENCODE_WORKFLOW_CANONICAL_MATERIALIZER: NativeProjectExactGraphCanonicalMaterializer = {
    ref: OPENCODE_WORKFLOW_TARGET_COMPONENTS.canonical,
    degradationKinds: ["runtime_specific_metadata_lost"],
    reasonCode: "opencode_workflow_reviewed_canonical_conversion",
    diagnosticMessage:
        "OAAM can write the portable Workflow as an OpenCode command; source-runtime private settings remain preserved in the source Version but are not expressed in this target",
    materialize: materializeCanonicalWorkflow,
    validateEntry: validateCanonicalWorkflowEntry,
};

function validateCanonicalWorkflowEntry(input: CanonicalRenderEntryValidationInput): boolean {
    if (
        input.canonical.kind !== "Workflow" ||
        input.nativeDialectId !== OPENCODE_NATIVE_DIALECTS.commandWorkflow ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text" ||
        !isPortableWorkflowSemantics(input.canonical.typeData, input.canonicalEntry.text)
    )
        return false;
    const data = input.canonical.typeData;
    if (
        input.nativeEntry.relativePath !==
        `${input.targetScope === "project" ? ".opencode/commands/" : "commands/"}${data.name}.md`
    )
        return false;
    const execution = data.implementation.execution;
    const expected = Object.fromEntries(
        Object.entries({
            description: data.description.trim() !== "" ? data.description : undefined,
            model: execution.model.mode === "selected" ? execution.model.selector : undefined,
            variant: execution.effort.mode === "selected" ? execution.effort.selector : undefined,
            subtask: execution.mode === "isolated" ? true : undefined,
        }).filter(([, value]) => value !== undefined),
    );
    const parsed = parseOpencodeFrontmatter(input.nativeEntry.content.text);
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
    const portable = portableWorkflow(input.targetCanonical, input.targetFiles);
    if (
        input.assetKind !== "Workflow" ||
        input.nativeDialectId !== OPENCODE_NATIVE_DIALECTS.commandWorkflow ||
        input.restorationInputs.length !== 0 ||
        portable === null
    ) {
        return null;
    }
    const relativePath =
        input.targetScope === "project"
            ? (`.opencode/commands/${portable.typeData.name}.md` as PosixRelativePath)
            : (`commands/${portable.typeData.name}.md` as PosixRelativePath);
    const lines = ["---"];
    if (portable.typeData.description.trim() !== "") {
        lines.push(`description: ${JSON.stringify(portable.typeData.description)}`);
    }
    const execution = portable.typeData.implementation.execution;
    if (execution.model.mode === "selected") lines.push(`model: ${JSON.stringify(execution.model.selector)}`);
    if (execution.effort.mode === "selected") lines.push(`variant: ${JSON.stringify(execution.effort.selector)}`);
    if (execution.mode === "isolated") lines.push("subtask: true");
    lines.push("---", portable.entry.text);
    return { nativeFiles: [textNativeFile(relativePath, lines.join("\n"))] };
}

function portableWorkflow(
    canonical: NativeProjectExactGraphCanonicalMaterializationInput["targetCanonical"],
    files: NativeProjectExactGraphCanonicalMaterializationInput["targetFiles"],
): {
    typeData: WorkflowTypeDataV2 & { implementation: Extract<WorkflowTypeDataV2["implementation"], { kind: "instructions" }> };
    entry: Extract<(typeof files)[number], { contentKind: "text" }>;
} | null {
    if (canonical.kind !== "Workflow" || files.length !== 1) return null;
    const typeData = canonical.typeData;
    const entry = files[0];
    if (
        entry?.contentKind !== "text" ||
        entry.file.role !== "entry" ||
        entry.file.logicalPath !== ENTRY_NAME ||
        entry.file.executable ||
        !isPortableWorkflowSemantics(typeData, entry.text)
    ) {
        return null;
    }
    return { typeData: { ...typeData, implementation: typeData.implementation }, entry };
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
        !isSafeCommandName(typeData.name) ||
        implementation.execution.agent.mode !== "agent_runtime_default" ||
        !portableSelector(implementation.execution.model, MODEL_DIALECT) ||
        !portableSelector(implementation.execution.effort, VARIANT_DIALECT) ||
        !portableShell(implementation.execution.shell.mode, body) ||
        implementation.toolPolicy.preapproved.length !== 0 ||
        implementation.toolPolicy.denied.length !== 0 ||
        implementation.toolPolicy.otherwise !== "inherit_agent_runtime_policy" ||
        typeData.invocation.commandNames.length !== 1 ||
        typeData.invocation.commandNames[0] !== typeData.name ||
        !typeData.invocation.userInvocable ||
        typeData.invocation.agentInvocable ||
        typeData.invocation.argumentHint !== "" ||
        !sameTextList(typeData.invocation.argumentNames, commandArguments(body))
    )
        return false;
    return true;
}

function portableSelector(
    value: { mode: "inherit" } | { mode: "selected"; dialectId: string; selector: string },
    dialectId: string,
): boolean {
    return value.mode === "inherit" || (value.dialectId === dialectId && value.selector.trim() !== "");
}

function portableShell(mode: "none" | "agent_runtime_default" | "selected", body: string): boolean {
    const shell = containsShellSubstitution(body);
    return (mode === "none" && !shell) || (mode === "agent_runtime_default" && shell);
}

function workflowGraph(files: readonly RenderNativeRepresentationFileInput[], scope: "project" | "global") {
    const file = files[0];
    if (
        files.length !== 1 ||
        file?.contentKind !== "text" ||
        file.executable ||
        !isWorkflowPath(file.relativePath, scope) ||
        splitWorkflowDocument(file.text) === null
    ) {
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
        input.nativeDialectId !== OPENCODE_NATIVE_DIALECTS.commandWorkflow ||
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
        parent.executable ||
        target.file.executable ||
        target.file.role !== "entry" ||
        target.file.logicalPath !== ENTRY_NAME ||
        (workflowGraph(input.parent.files, "project") === null && workflowGraph(input.parent.files, "global") === null)
    ) {
        return null;
    }
    const parsed = splitWorkflowDocument(parent.text);
    const { text: parentText, ...descriptor } = parent;
    if (
        parsed === null ||
        !validateOpencodeNativeDialect({
            canonical: input.targetCanonical,
            canonicalFiles: [{ ...target, text: parsed.body }],
            representation: { ...input.parent.representation, files: [descriptor] },
            nativeFiles: [{ relativePath: parent.relativePath, bytes: new TextEncoder().encode(parentText) }],
        })
    ) {
        return null;
    }
    return { nativeFiles: [textNativeFile(parent.relativePath, `${parsed.prefix}${target.text}`)] };
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
        input.nativeDialectId !== OPENCODE_NATIVE_DIALECTS.commandWorkflow ||
        input.appliedContent.contentKind !== "text" ||
        input.currentContent.contentKind !== "text" ||
        (!isWorkflowPath(input.relativePath, "project") && !isWorkflowPath(input.relativePath, "global"))
    ) {
        return null;
    }
    const applied = splitWorkflowDocument(input.appliedContent.text);
    const current = splitWorkflowDocument(input.currentContent.text);
    if (
        applied === null ||
        current === null ||
        applied.prefix !== current.prefix ||
        containsShellSubstitution(applied.body) !== containsShellSubstitution(current.body) ||
        !sameTextList(commandArguments(applied.body), commandArguments(current.body)) ||
        !sameTextList(parseOpenCodeAtReferenceTokens(applied.body), parseOpenCodeAtReferenceTokens(current.body))
    ) {
        return null;
    }
    return { canonicalContent: { contentKind: "text" as const, text: current.body } };
}

function splitWorkflowDocument(text: string): { prefix: string; body: string } | null {
    const parsed = parseOpencodeFrontmatter(text);
    if (
        (parsed.hasFrontmatter && (!parsed.closed || parsed.diagnostics.length !== 0)) ||
        parsed.body.trim() === "" ||
        unknownKeys(parsed, [...ALLOWED_FRONTMATTER]).length !== 0 ||
        !validOptionalString(parsed, "description") ||
        !validOptionalString(parsed, "agent") ||
        !validOptionalString(parsed, "model") ||
        !validOptionalString(parsed, "variant") ||
        !validOptionalBoolean(parsed, "subtask")
    ) {
        return null;
    }
    const agent = frontmatterString(parsed, "agent")?.trim();
    if (agent && frontmatterBoolean(parsed, "subtask") === undefined) return null;
    return { prefix: text.slice(0, text.length - parsed.body.length), body: parsed.body };
}

function validOptionalString(parsed: ReturnType<typeof parseOpencodeFrontmatter>, key: string): boolean {
    return !parsed.presentKeys.includes(key) || frontmatterString(parsed, key) !== undefined;
}

function validOptionalBoolean(parsed: ReturnType<typeof parseOpencodeFrontmatter>, key: string): boolean {
    return !parsed.presentKeys.includes(key) || frontmatterBoolean(parsed, key) !== undefined;
}

function isWorkflowPath(relativePath: PosixRelativePath, scope: "project" | "global"): boolean {
    if (relativePath.includes("\0") || relativePath.includes("\\") || !relativePath.endsWith(".md")) return false;
    const segments = relativePath.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
    const prefix = scope === "project" ? segments.slice(0, 2).join("/") : segments[0];
    return scope === "project"
        ? (prefix === ".opencode/command" || prefix === ".opencode/commands") && segments.length >= 3
        : (prefix === "command" || prefix === "commands") && segments.length >= 2;
}

function isSafeCommandName(name: string): boolean {
    const segments = name.split("/");
    return name !== "" && !name.endsWith(".md") && segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment));
}

function textNativeFile(
    relativePath: PosixRelativePath,
    text: string,
): Extract<RenderNativeRepresentationFileInput, { contentKind: "text" }> {
    const bytes = new TextEncoder().encode(text);
    return {
        relativePath,
        contentKind: "text",
        mediaType: "text/markdown",
        executable: false,
        contentHash: sha256SourceBytes(bytes),
        byteSize: bytes.byteLength,
        text,
    };
}

export async function analyzeOpencodeWorkflowTargets(
    input: RenderAnalysisInput,
    supports: OpencodeWorkflowTargetSupports,
): Promise<AdapterRenderAnalysisResult> {
    const results: AdapterRenderAnalysisResult[] = [];
    const classified = new Set<string>();
    const assets = new Map(input.deployment.assets.map((asset) => [versionKey(asset.version.ref), asset]));
    for (const scope of ["project", "global"] as const) {
        const support = supports[scope];
        const keys = new Set(
            input.dialectInputs
                .filter(
                    (entry) =>
                        assets.get(versionKey(entry.targetVersion))?.scope === scope &&
                        entry.inputs.some(
                            (candidate) =>
                                (candidate.inputKind === "native_representation" &&
                                    candidate.representation.dialectId === OPENCODE_NATIVE_DIALECTS.commandWorkflow) ||
                                (candidate.inputKind === "canonical_materialization" &&
                                    candidate.nativeDialectId === OPENCODE_NATIVE_DIALECTS.commandWorkflow),
                        ),
                )
                .map((entry) => versionKey(entry.targetVersion)),
        );
        if (keys.size === 0) continue;
        for (const key of keys) classified.add(key);
        const projected: RenderAnalysisInput = {
            schemaVersion: 1,
            deployment: {
                ...input.deployment,
                targetContexts: input.deployment.targetContexts.filter(
                    (context) => context.targetContextSchemaId === support.targetContextSchema.targetContextSchemaId,
                ),
                assets: input.deployment.assets.filter((asset) => keys.has(versionKey(asset.version.ref))),
            },
            requiredSemantics: input.requiredSemantics.filter((semantic) => keys.has(versionKey(semantic.subject))),
            dialectInputs: input.dialectInputs.filter((entry) => keys.has(versionKey(entry.targetVersion))),
        };
        results.push(
            appendOpencodeBuildCompatibilityWarning(
                await support.analyze(projected),
                projected,
                support.renderContractDeclaration,
            ),
        );
    }
    const unclassified = input.requiredSemantics.filter((semantic) => !classified.has(versionKey(semantic.subject)));
    if (unclassified.length > 0) {
        const unavailable = diagnostic(
            "render",
            "opencode_workflow_native_variant_unavailable",
            "OpenCode Workflow target requires one scope-matched Markdown-command native or reviewed canonical lineage",
            "unsupported",
            "error",
        );
        results.push({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: unclassified.map((semantic) => ({
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                reasonCode: unavailable.code,
                diagnostics: [unavailable],
            })),
            diagnostics: [unavailable],
        });
    }
    return explainModelInvocationRefusal(input, mergeWorkflowAnalysis(input, results));
}

function mergeWorkflowAnalysis(
    input: RenderAnalysisInput,
    results: readonly AdapterRenderAnalysisResult[],
): AdapterRenderAnalysisResult {
    const outputUnits = results.flatMap((result) => result.outputUnits);
    const semanticOptions = results.flatMap((result) => result.semanticOptions);
    const blockedSemanticRefs = results.flatMap((result) => result.blockedSemanticRefs);
    const diagnostics = results.flatMap((result) => result.diagnostics);
    const expected = input.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(compareText);
    const actual = [
        ...semanticOptions.map((option) => option.semanticRefFingerprint),
        ...blockedSemanticRefs.map((blocked) => blocked.semanticRefFingerprint),
    ].sort(compareText);
    if (
        expected.length !== actual.length ||
        expected.some((fingerprint, index) => fingerprint !== actual[index]) ||
        new Set(actual).size !== actual.length ||
        new Set(outputUnits.map((unit) => unit.outputUnitFingerprint)).size !== outputUnits.length
    ) {
        const invalid = diagnostic(
            "render",
            "opencode_workflow_variant_closure_invalid",
            "OpenCode Workflow target variants did not classify one exact semantic closure",
            "conflict",
            "error",
        );
        return {
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                reasonCode: invalid.code,
                diagnostics: [invalid],
            })),
            diagnostics: [invalid],
        };
    }
    outputUnits.sort((left, right) => compareText(left.outputUnitFingerprint, right.outputUnitFingerprint));
    semanticOptions.sort((left, right) =>
        compareText(
            `${left.semanticRefFingerprint}\0${left.optionFingerprint}`,
            `${right.semanticRefFingerprint}\0${right.optionFingerprint}`,
        ),
    );
    blockedSemanticRefs.sort((left, right) => compareText(left.semanticRefFingerprint, right.semanticRefFingerprint));
    return {
        status: blockedSemanticRefs.length === 0 ? "complete" : semanticOptions.length === 0 ? "failed" : "partial",
        outputUnits,
        semanticOptions,
        blockedSemanticRefs,
        diagnostics,
    };
}

function versionKey(ref: { assetId: string; versionId: string }): string {
    return `${ref.assetId}\0${ref.versionId}`;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function sameTextList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Markdown commands cannot preserve an instruction Workflow's model invocation. */
function explainModelInvocationRefusal(
    input: RenderAnalysisInput,
    result: AdapterRenderAnalysisResult,
): AdapterRenderAnalysisResult {
    const issue = diagnostic(
        "render",
        "opencode_workflow_model_invocation_unsupported",
        "OpenCode Markdown commands cannot preserve model-initiated Workflow invocation; this asset cannot be deployed to this target",
        "unsupported",
        "error",
    );
    let changed = false;
    const blockedSemanticRefs = result.blockedSemanticRefs.map((blocked) => {
        const semantic = input.requiredSemantics.find((item) => item.semanticRefFingerprint === blocked.semanticRefFingerprint);
        const asset = input.deployment.assets.find(
            (item) => semantic !== undefined && versionKey(item.version.ref) === versionKey(semantic.subject),
        );
        const canonical = asset?.version.canonical;
        if (
            canonical?.kind !== "Workflow" ||
            canonical.typeData.implementation.kind !== "instructions" ||
            !canonical.typeData.invocation.agentInvocable ||
            blocked.diagnostics.length === 0 ||
            blocked.diagnostics.some((item) => item.causeKind !== "unsupported" || item.retryable)
        )
            return blocked;
        changed = true;
        return { ...blocked, reasonCode: issue.code, diagnostics: [issue] };
    });
    if (!changed) return result;
    const previous = new Set(result.blockedSemanticRefs.flatMap((item) => item.diagnostics.map((diagnostic) => diagnostic.code)));
    const remaining = new Set(blockedSemanticRefs.flatMap((item) => item.diagnostics.map((diagnostic) => diagnostic.code)));
    return {
        ...result,
        blockedSemanticRefs,
        diagnostics: [...result.diagnostics.filter((item) => !previous.has(item.code) || remaining.has(item.code)), issue],
    };
}
