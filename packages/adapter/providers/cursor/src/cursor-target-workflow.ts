/** Exact Cursor Agent CLI/App project and personal command Workflow targets. */

import {
    compareCodeUnitText as compareText,
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
import { CURSOR_NATIVE_DIALECTS } from "./cursor-source-read-model";
import { cursorCommandArgumentNames, isCursorCommandPath, parseCursorCommand } from "./cursor-source-read-workflow";
import {
    appendCursorBuildCompatibilityWarning,
    CURSOR_AGENT_TARGET_BUILD_COMPATIBILITY,
} from "./cursor-target-build-compatibility";

const ENTRY_PATH = "WORKFLOW.md" as PosixRelativePath;
const GLOBAL_FACTS = { "oaam.target-kind": "global" } as const;
const CURSOR_COMMAND_DIALECTS: readonly string[] = [
    CURSOR_NATIVE_DIALECTS.agentCommandWorkflow,
    CURSOR_NATIVE_DIALECTS.appCommandWorkflow,
];

interface WorkflowRuntimeSpec {
    agentRuntimeId: "CURSOR_AGENT_CLI" | "CURSOR_APP";
    nativeDialectId: string;
    app: boolean;
    profilePrefix: string;
    capabilityPrefix: string;
    outputPrefix: string;
    projectFixtureName: string;
    globalFixtureName: string;
    builds: readonly {
        versionText: string;
        buildIdentity: `sha256:${string}`;
        platform: "linux" | "win32" | "wsl";
        fixturePrefix: string;
        projectLoadMarker?: string;
        globalLoadMarker?: string;
    }[];
}

const CLI_SPEC = {
    agentRuntimeId: "CURSOR_AGENT_CLI",
    nativeDialectId: CURSOR_NATIVE_DIALECTS.agentCommandWorkflow,
    app: false,
    profilePrefix: "cursor-agent-cli",
    capabilityPrefix: "cursor.agent-cli",
    outputPrefix: "CURSOR_AGENT_CLI",
    projectFixtureName: "oaam-phase58-cli-workflow",
    globalFixtureName: "oaam-phase58-cli-workflow",
    builds: [
        {
            versionText: "2026.07.23-e383d2b",
            buildIdentity: "sha256:eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831",
            platform: "wsl",
            fixturePrefix: "cursor-agent-cli-2026.07.23-wsl",
        },
    ],
} as const satisfies WorkflowRuntimeSpec;

const APP_SPEC = {
    agentRuntimeId: "CURSOR_APP",
    nativeDialectId: CURSOR_NATIVE_DIALECTS.appCommandWorkflow,
    app: true,
    profilePrefix: "cursor-app",
    capabilityPrefix: "cursor.app",
    outputPrefix: "CURSOR_APP",
    projectFixtureName: "oaam-app-workflow",
    globalFixtureName: "oaam-phase59-app-global-workflow",
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
            projectLoadMarker: "OAAM_CURSOR_APP_WORKFLOW_4A3F",
            globalLoadMarker: "OAAM_PHASE58_CURSOR_APP_GLOBAL_WORKFLOW_27B5C9",
        },
    ],
} as const satisfies WorkflowRuntimeSpec;

export interface CursorWorkflowTargetSupports {
    project: NativeProjectExactGraphProviderSupport;
    global: NativeGlobalExactGraphProviderSupport;
}

interface CursorWorkflowReverseInput {
    assetKind: "Rule" | "Workflow" | "Skill" | "Subagent";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}

export const CURSOR_WORKFLOW_TARGET_COMPONENTS = {
    project: component("cursor.command-workflow-project-graph-v1"),
    global: component("cursor.command-workflow-global-graph-v1"),
    agentReverse: component(`${CURSOR_NATIVE_DIALECTS.agentCommandWorkflow}.native-to-canonical-parser`),
    appReverse: component(`${CURSOR_NATIVE_DIALECTS.appCommandWorkflow}.native-to-canonical-parser`),
    rebase: component("cursor.command-workflow-parent-native-rebase-v1"),
    canonical: component("cursor.command-workflow-reviewed-canonical-materialization-v1"),
} as const;

export function createCursorCliWorkflowTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
}): CursorWorkflowTargetSupports {
    return createWorkflowTargetSupports(CLI_SPEC, input);
}

export function createCursorAppWorkflowTargetSupports(
    input: Parameters<typeof createCursorCliWorkflowTargetSupports>[0],
): CursorWorkflowTargetSupports {
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
): CursorWorkflowTargetSupports {
    const reverseParser =
        spec.agentRuntimeId === "CURSOR_APP"
            ? CURSOR_WORKFLOW_TARGET_COMPONENTS.appReverse
            : CURSOR_WORKFLOW_TARGET_COMPONENTS.agentReverse;
    const projectProfile = `${spec.profilePrefix}-project-workflow-v1`;
    const globalProfile = `${spec.profilePrefix}-global-workflow-v1`;
    const projectPath = `.cursor/commands/${spec.projectFixtureName}.md` as PosixRelativePath;
    const globalPath = `commands/${spec.globalFixtureName}.md` as PosixRelativePath;
    const projectBuilds = spec.builds.map((build) =>
        createVerifiedNativeProjectExactGraphBuild({
            agentRuntimeId: spec.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: projectProfile,
            fixtureId: `${build.fixturePrefix}-project-command-workflow-2026-08-08`,
            assetKind: "Workflow",
            nativeDialectId: spec.nativeDialectId,
            projectGraphValidator: CURSOR_WORKFLOW_TARGET_COMPONENTS.project,
            reverseParser,
            rebaseMaterializer: CURSOR_WORKFLOW_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: canonicalMaterializationDeclaration(),
            restorationDialectIds: [],
            parentRebaseFixtureId: `${build.fixturePrefix}-project-command-workflow-parent-rebase-v1`,
            targetGraphIdentity: projectPath,
            targetRelativePaths: [projectPath],
            exactLoadMarker: build.projectLoadMarker ?? `OAAM_PHASE58_${spec.agentRuntimeId}_PROJECT_WORKFLOW_61D4A8`,
            reverseFixtureId: `${build.fixturePrefix}-project-command-workflow-reverse-v1`,
        }),
    );
    const globalBuilds = spec.builds.map((build) =>
        createVerifiedNativeGlobalExactGraphBuild({
            agentRuntimeId: spec.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: globalProfile,
            fixtureId: `${build.fixturePrefix}-global-command-workflow-2026-08-08`,
            assetKind: "Workflow",
            nativeDialectId: spec.nativeDialectId,
            globalGraphValidator: CURSOR_WORKFLOW_TARGET_COMPONENTS.global,
            reverseParser,
            rebaseMaterializer: CURSOR_WORKFLOW_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: canonicalMaterializationDeclaration(),
            restorationDialectIds: [],
            parentRebaseFixtureId: `${build.fixturePrefix}-global-command-workflow-parent-rebase-v1`,
            targetGraphIdentity: globalPath,
            targetRelativePaths: [globalPath],
            exactLoadMarker: build.globalLoadMarker ?? `OAAM_PHASE58_${spec.agentRuntimeId}_GLOBAL_WORKFLOW_27B5C9`,
            reverseFixtureId: `${build.fixturePrefix}-global-command-workflow-reverse-v1`,
        }),
    );
    const canonicalMaterializer = createCanonicalMaterializer(spec);
    const common = {
        adapterId: "CURSOR" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: "Workflow" as const,
        nativeDialectId: spec.nativeDialectId,
        reverseParser: {
            ref: reverseParser,
            parse: (value: CursorWorkflowReverseInput) => parseChangedWorkflow(spec, value),
        },
        rebaseMaterializer: {
            ref: CURSOR_WORKFLOW_TARGET_COMPONENTS.rebase,
            materialize: (value: NativeProjectExactGraphRebaseInput) => materializeWorkflowParent(spec, value),
        },
        canonicalMaterializer,
        restorationDialectIds: [],
        buildCompatibility: CURSOR_AGENT_TARGET_BUILD_COMPATIBILITY,
    };
    return {
        project: createNativeProjectExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_NATIVE_PROJECT_WORKFLOW_V1`,
            materializationProfileId: projectProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-project-workflow-v1`,
            projectGraphValidator: {
                ref: CURSOR_WORKFLOW_TARGET_COMPONENTS.project,
                project: (files) => workflowGraph(spec, files, "project"),
            },
            target: {
                targetContextSchemaId: input.projectTargetContextSchemaId,
                requiredFacts: { "oaam.project-binding": "registered" },
            },
            verifiedBuilds: projectBuilds,
        }),
        global: createNativeGlobalExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_NATIVE_GLOBAL_WORKFLOW_V1`,
            materializationProfileId: globalProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-global-workflow-v1`,
            globalGraphValidator: {
                ref: CURSOR_WORKFLOW_TARGET_COMPONENTS.global,
                validate: (files) => workflowGraph(spec, files, "global"),
            },
            target: { targetContextSchemaId: input.globalTargetContextSchemaId, requiredFacts: GLOBAL_FACTS },
            verifiedBuilds: globalBuilds,
        }),
    };
}

function canonicalMaterializationDeclaration() {
    return {
        materializer: CURSOR_WORKFLOW_TARGET_COMPONENTS.canonical,
        degradationKinds: ["runtime_specific_metadata_lost"] as ["runtime_specific_metadata_lost"],
        reasonCode: "cursor_workflow_reviewed_same_family_conversion",
    };
}

function createCanonicalMaterializer(spec: WorkflowRuntimeSpec): NativeProjectExactGraphCanonicalMaterializer {
    return {
        ref: CURSOR_WORKFLOW_TARGET_COMPONENTS.canonical,
        degradationKinds: ["runtime_specific_metadata_lost"],
        reasonCode: "cursor_workflow_reviewed_same_family_conversion",
        diagnosticMessage:
            "OAAM can convert the common Cursor command semantics between current Cursor entries; the source native path remains preserved in its source Version",
        materialize: (input) => materializeCanonicalWorkflow(spec, input),
        validateEntry: (input) => validateCanonicalWorkflowEntry(input, spec),
    };
}

function validateCanonicalWorkflowEntry(input: CanonicalRenderEntryValidationInput, spec: WorkflowRuntimeSpec): boolean {
    if (
        input.canonical.kind !== "Workflow" ||
        input.nativeDialectId !== spec.nativeDialectId ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text" ||
        !isPortableWorkflowSemantics(input.canonical.typeData, input.canonicalEntry.text) ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(input.canonical.typeData.name)
    )
        return false;
    return (
        input.nativeEntry.relativePath ===
            `${input.targetScope === "project" ? ".cursor/commands/" : "commands/"}${input.canonical.typeData.name}.md` &&
        input.nativeEntry.content.text === input.canonicalEntry.text
    );
}

function materializeCanonicalWorkflow(
    spec: WorkflowRuntimeSpec,
    input: NativeProjectExactGraphCanonicalMaterializationInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    const portable = portableCursorWorkflow(input.targetCanonical, input.targetFiles);
    if (
        input.assetKind !== "Workflow" ||
        input.nativeDialectId !== spec.nativeDialectId ||
        input.restorationInputs.length !== 0 ||
        portable === null ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(portable.typeData.name)
    ) {
        return null;
    }
    const relativePath =
        input.targetScope === "project"
            ? (`.cursor/commands/${portable.typeData.name}.md` as PosixRelativePath)
            : (`commands/${portable.typeData.name}.md` as PosixRelativePath);
    return { nativeFiles: [textNativeFile(relativePath, portable.entry.text)] };
}

function portableCursorWorkflow(
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
        entry.file.logicalPath !== ENTRY_PATH ||
        entry.file.executable ||
        entry.file.references.length !== 0 ||
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
        !CURSOR_COMMAND_DIALECTS.includes(implementation.instructionDialectId) ||
        implementation.execution.mode !== "caller" ||
        implementation.execution.agent.mode !== "agent_runtime_default" ||
        implementation.execution.model.mode !== "inherit" ||
        implementation.execution.effort.mode !== "inherit" ||
        implementation.execution.shell.mode !== "none" ||
        implementation.toolPolicy.preapproved.length !== 0 ||
        implementation.toolPolicy.denied.length !== 0 ||
        implementation.toolPolicy.otherwise !== "inherit_agent_runtime_policy" ||
        typeData.invocation.commandNames.length !== 1 ||
        typeData.invocation.commandNames[0] !== typeData.name ||
        !typeData.invocation.userInvocable ||
        typeData.invocation.agentInvocable ||
        typeData.invocation.argumentHint !== "" ||
        !sameStrings(typeData.invocation.argumentNames, cursorCommandArgumentNames(body)) ||
        commandDescription(body, typeData.name) !== typeData.description
    )
        return false;
    return true;
}

function workflowGraph(
    spec: WorkflowRuntimeSpec,
    files: readonly RenderNativeRepresentationFileInput[],
    scope: "project" | "global",
) {
    const file = files[0];
    if (
        files.length !== 1 ||
        file?.contentKind !== "text" ||
        file.executable ||
        !isCursorCommandPath(file.relativePath, spec.app, scope) ||
        parseNativeWorkflow(spec, file.relativePath, file.text) === null
    ) {
        return null;
    }
    return {
        graphIdentityRelativePath: file.relativePath,
        files: [{ nativeRelativePath: file.relativePath, canonicalLogicalPath: ENTRY_PATH }],
        managedDirectoryBoundaries: [],
    };
}

function materializeWorkflowParent(
    spec: WorkflowRuntimeSpec,
    input: NativeProjectExactGraphRebaseInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (
        input.assetKind !== "Workflow" ||
        input.nativeDialectId !== spec.nativeDialectId ||
        input.targetCanonical.kind !== "Workflow" ||
        input.restorationInputs.length !== 0 ||
        input.parent.files.length !== 1 ||
        input.targetFiles.length !== 1
    ) {
        return null;
    }
    const parent = input.parent.files[0];
    const target = input.targetFiles[0];
    const scope = parent?.relativePath.startsWith("commands/") ? "global" : "project";
    if (
        parent?.contentKind !== "text" ||
        target?.contentKind !== "text" ||
        parent.executable ||
        target.file.executable ||
        target.file.role !== "entry" ||
        target.file.logicalPath !== ENTRY_PATH ||
        target.file.references.length !== 0 ||
        !isCursorCommandPath(parent.relativePath, spec.app, scope) ||
        parseNativeWorkflow(spec, parent.relativePath, parent.text) === null ||
        !canonicalMatchesNative(spec, input.targetCanonical.typeData, parent.relativePath, target.text)
    ) {
        return null;
    }
    return { nativeFiles: [textNativeFile(parent.relativePath, target.text)] };
}

function parseChangedWorkflow(spec: WorkflowRuntimeSpec, input: CursorWorkflowReverseInput) {
    const scope = input.relativePath.startsWith("commands/") ? "global" : "project";
    if (
        input.assetKind !== "Workflow" ||
        input.nativeDialectId !== spec.nativeDialectId ||
        input.appliedContent.contentKind !== "text" ||
        input.currentContent.contentKind !== "text" ||
        !isCursorCommandPath(input.relativePath, spec.app, scope)
    ) {
        return null;
    }
    const applied = parseNativeWorkflow(spec, input.relativePath, input.appliedContent.text);
    const current = parseNativeWorkflow(spec, input.relativePath, input.currentContent.text);
    if (applied === null || current === null || !stableSourceValueEqual(applied.typeData, current.typeData)) return null;
    return { canonicalContent: { contentKind: "text" as const, text: input.currentContent.text } };
}

function parseNativeWorkflow(spec: WorkflowRuntimeSpec, relativePath: string, text: string) {
    const scope = relativePath.startsWith("commands/") ? "global" : "project";
    const parsed = parseCursorCommand(
        { agentRuntimeId: spec.agentRuntimeId, layout: scope === "global" ? "config" : "project" },
        { relativePath, text },
    );
    return parsed.nativeDialectId === spec.nativeDialectId && parsed.diagnostics.every((item) => item.severity !== "error")
        ? parsed
        : null;
}

function canonicalMatchesNative(
    spec: WorkflowRuntimeSpec,
    typeData: WorkflowTypeDataV2,
    relativePath: string,
    text: string,
): boolean {
    const parsed = parseNativeWorkflow(spec, relativePath, text);
    return parsed !== null && stableSourceValueEqual(typeData, parsed.typeData);
}

function textNativeFile(relativePath: PosixRelativePath, text: string): RenderNativeRepresentationFileInput {
    const bytes = new TextEncoder().encode(text);
    return {
        relativePath,
        contentKind: "text",
        mediaType: relativePath.endsWith(".txt") ? "text/plain" : "text/markdown",
        executable: false,
        contentHash: sha256SourceBytes(bytes),
        byteSize: bytes.byteLength,
        text,
    };
}

function commandDescription(body: string, fallback: string): string {
    const first = body.split("\n", 1)[0]?.trim() ?? "";
    if (first === "") return fallback;
    const heading = /^#+\s*(.+)$/u.exec(first);
    return heading?.[1]?.trim() || first;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function analyzeCursorWorkflowTargets(
    input: RenderAnalysisInput,
    supports: CursorWorkflowTargetSupports,
): Promise<AdapterRenderAnalysisResult> {
    const results: AdapterRenderAnalysisResult[] = [];
    const classified = new Set<string>();
    const assets = new Map(input.deployment.assets.map((asset) => [versionKey(asset.version.ref), asset]));
    for (const scope of ["project", "global"] as const) {
        const support = supports[scope];
        const dialectId = support.renderContractDeclaration.nativeDialectId;
        const keys = new Set(
            input.dialectInputs
                .filter(
                    (entry) =>
                        assets.get(versionKey(entry.targetVersion))?.scope === scope &&
                        entry.inputs.some(
                            (candidate) =>
                                (candidate.inputKind === "native_representation" &&
                                    candidate.representation.dialectId === dialectId) ||
                                (candidate.inputKind === "canonical_materialization" && candidate.nativeDialectId === dialectId),
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
            appendCursorBuildCompatibilityWarning(await support.analyze(projected), projected, support.renderContractDeclaration),
        );
    }
    const unclassified = input.requiredSemantics.filter((semantic) => !classified.has(versionKey(semantic.subject)));
    if (unclassified.length > 0) {
        const issue = diagnostic(
            "render",
            "cursor_workflow_native_variant_unavailable",
            "Cursor Workflow target requires one scope-matched command native representation or reviewed same-family conversion",
            "unsupported",
            "error",
        );
        results.push({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: unclassified.map((semantic) => ({
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                reasonCode: issue.code,
                diagnostics: [issue],
            })),
            diagnostics: [issue],
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
        const issue = diagnostic(
            "render",
            "cursor_workflow_variant_closure_invalid",
            "Cursor Workflow target variants did not classify one exact semantic closure",
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

/** Markdown commands cannot preserve an instruction Workflow's model invocation. */
function explainModelInvocationRefusal(
    input: RenderAnalysisInput,
    result: AdapterRenderAnalysisResult,
): AdapterRenderAnalysisResult {
    const issue = diagnostic(
        "render",
        "cursor_workflow_model_invocation_unsupported",
        "Cursor Markdown commands cannot preserve model-initiated Workflow invocation; this asset cannot be deployed to this target",
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
