/** Exact ZCode App project/global Markdown-command Workflow targets. */

import {
    adapterOperationDiagnostic as diagnostic,
    defineDialectComponentV1 as component,
    sha256SourceBytes,
} from "@oaam/adapter-framework";
import {
    type AdapterRenderAnalysisResult,
    type AgentRuntimeDescriptor,
    createNativeGlobalExactGraphProviderSupport,
    createNativeProjectExactGraphProviderSupport,
    createVerifiedNativeGlobalExactGraphBuild,
    createVerifiedNativeProjectExactGraphBuild,
    type NativeGlobalExactGraphProviderSupport,
    type NativeProjectExactGraphProviderSupport,
    type NativeProjectExactGraphRebaseInput,
    type PosixRelativePath,
    type RenderAnalysisInput,
    type RenderNativeRepresentationFileInput,
} from "@oaam/core/adapter-spi";
import { parseZcodeCommandFrontmatter } from "./zcode-frontmatter";
import { commandArgumentNames, containsUnsupportedShellExpansion, fallbackDescription } from "./zcode-source-read-fields";
import { ZCODE_NATIVE_DIALECTS } from "./zcode-source-read-model";
import { validateZcodeNativeDialect } from "./zcode-source-read-native";
import { appendZcodeBuildCompatibilityWarning, ZCODE_APP_TARGET_BUILD_COMPATIBILITY } from "./zcode-target-build-compatibility";
import { ZCODE_CURRENT_TARGET_BUILD, ZCODE_HISTORICAL_DECLARATION_FLOOR } from "./zcode-target-builds";

const PROJECT_FACTS = { "oaam.project-binding": "registered" } as const;
const GLOBAL_FACTS = { "oaam.target-kind": "global" } as const;
const COMMAND_ENTRY = "WORKFLOW.md" as PosixRelativePath;
const TARGETS = {
    projectCommand: ".zcode/commands/oaam-phase56-workflow.md",
    globalCommand: "commands/oaam-phase56-global-workflow.md",
} as const satisfies Record<string, PosixRelativePath>;

export const ZCODE_WORKFLOW_TARGET_COMPONENTS = {
    projectCommand: component("zcode.project-command-workflow-one-file-v1"),
    globalCommand: component("zcode.global-command-workflow-one-file-v1"),
    commandReverse: component(`${ZCODE_NATIVE_DIALECTS.commandWorkflow}.native-to-canonical-parser`),
    commandRebase: component("zcode.command-workflow-parent-native-rebase-v1"),
} as const;

export interface ZcodeWorkflowTargetSupports {
    projectCommand: NativeProjectExactGraphProviderSupport;
    globalCommand: NativeGlobalExactGraphProviderSupport;
}

interface SupportFactoryInput {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
}

interface WorkflowVariantSpec {
    key: keyof ZcodeWorkflowTargetSupports;
    scope: "project" | "global";
    targetPath: PosixRelativePath;
    graphComponent: (typeof ZCODE_WORKFLOW_TARGET_COMPONENTS)["projectCommand"];
    outputContractId: string;
    materializationProfileId: string;
    materializerCapabilityKey: string;
    fixtureSlug: string;
    loadMarker: string;
}

const VARIANTS: readonly WorkflowVariantSpec[] = [
    {
        key: "projectCommand",
        scope: "project",
        targetPath: TARGETS.projectCommand,
        graphComponent: ZCODE_WORKFLOW_TARGET_COMPONENTS.projectCommand,
        outputContractId: "ZCODE_NATIVE_PROJECT_COMMAND_WORKFLOW_V1",
        materializationProfileId: "zcode-app-project-command-workflow-v1",
        materializerCapabilityKey: "zcode.project-command-workflow-v1",
        fixtureSlug: "project-command-workflow",
        loadMarker: "OAAM_ZCODE_353_PROJECT_COMMAND_WORKFLOW_9C42E1",
    },
    {
        key: "globalCommand",
        scope: "global",
        targetPath: TARGETS.globalCommand,
        graphComponent: ZCODE_WORKFLOW_TARGET_COMPONENTS.globalCommand,
        outputContractId: "ZCODE_NATIVE_GLOBAL_COMMAND_WORKFLOW_V1",
        materializationProfileId: "zcode-app-global-command-workflow-v1",
        materializerCapabilityKey: "zcode.global-command-workflow-v1",
        fixtureSlug: "global-command-workflow",
        loadMarker: "OAAM_ZCODE_353_GLOBAL_COMMAND_WORKFLOW_1A73B8",
    },
];

export function createZcodeWorkflowTargetSupports(input: SupportFactoryInput): ZcodeWorkflowTargetSupports {
    const entries = VARIANTS.map((spec) => [spec.key, createVariantSupport(spec, input)] as const);
    return Object.fromEntries(entries) as unknown as ZcodeWorkflowTargetSupports;
}

function createVariantSupport(
    spec: WorkflowVariantSpec,
    input: SupportFactoryInput,
): NativeProjectExactGraphProviderSupport | NativeGlobalExactGraphProviderSupport {
    const buildSpecs = [
        ...(["wsl", "win32"] as const).map((platform) => ({
            versionText: ZCODE_CURRENT_TARGET_BUILD.versionText,
            buildIdentity: ZCODE_CURRENT_TARGET_BUILD.buildIdentity,
            platform,
            fixtureSuffix: "2026-08-07",
            loadMarker: spec.loadMarker,
        })),
        {
            ...ZCODE_HISTORICAL_DECLARATION_FLOOR,
            fixtureSuffix: "historical-lifecycle-2026-08-17",
            loadMarker: `OAAM_ZCODE_HISTORICAL_${spec.key.toUpperCase()}_3_1_8`,
        },
    ] as const;
    const builds = buildSpecs.map((buildSpec) => {
        const common = {
            agentRuntimeId: "ZCODE_APP" as const,
            versionText: buildSpec.versionText,
            buildIdentity: buildSpec.buildIdentity,
            platform: buildSpec.platform,
            materializationProfileId: spec.materializationProfileId,
            fixtureId: `zcode-app-${buildSpec.versionText}-${buildSpec.platform}-${spec.fixtureSlug}-${buildSpec.fixtureSuffix}`,
            assetKind: "Workflow" as const,
            nativeDialectId: ZCODE_NATIVE_DIALECTS.commandWorkflow,
            reverseParser: ZCODE_WORKFLOW_TARGET_COMPONENTS.commandReverse,
            rebaseMaterializer: ZCODE_WORKFLOW_TARGET_COMPONENTS.commandRebase,
            restorationDialectIds: [],
            parentRebaseFixtureId: `zcode-app-${buildSpec.versionText}-${buildSpec.platform}-${spec.fixtureSlug}-parent-rebase-v1`,
            targetGraphIdentity: spec.targetPath,
            targetRelativePaths: [spec.targetPath],
            exactLoadMarker: buildSpec.loadMarker,
            reverseFixtureId: `zcode-app-${buildSpec.versionText}-${buildSpec.platform}-${spec.fixtureSlug}-reverse-v1`,
        };
        return spec.scope === "project"
            ? createVerifiedNativeProjectExactGraphBuild({ ...common, projectGraphValidator: spec.graphComponent })
            : createVerifiedNativeGlobalExactGraphBuild({ ...common, globalGraphValidator: spec.graphComponent });
    });
    const common = {
        adapterId: "ZCODE" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: "ZCODE_APP" as const,
        assetKind: "Workflow" as const,
        outputContractId: spec.outputContractId,
        materializationProfileId: spec.materializationProfileId,
        materializerCapabilityKey: spec.materializerCapabilityKey,
        nativeDialectId: ZCODE_NATIVE_DIALECTS.commandWorkflow,
        reverseParser: {
            ref: ZCODE_WORKFLOW_TARGET_COMPONENTS.commandReverse,
            parse: parseChangedCommand,
        },
        rebaseMaterializer: {
            ref: ZCODE_WORKFLOW_TARGET_COMPONENTS.commandRebase,
            materialize: rebaseCommand,
        },
        restorationDialectIds: [],
        buildCompatibility: ZCODE_APP_TARGET_BUILD_COMPATIBILITY,
        target: {
            targetContextSchemaId:
                spec.scope === "project" ? input.projectTargetContextSchemaId : input.globalTargetContextSchemaId,
            requiredFacts: spec.scope === "project" ? PROJECT_FACTS : GLOBAL_FACTS,
        },
    };
    const validate = (files: readonly RenderNativeRepresentationFileInput[]) => workflowGraph(spec, files);
    return spec.scope === "project"
        ? createNativeProjectExactGraphProviderSupport({
              ...common,
              projectGraphValidator: { ref: spec.graphComponent, project: validate },
              verifiedBuilds: builds as ReturnType<typeof createVerifiedNativeProjectExactGraphBuild>[],
          })
        : createNativeGlobalExactGraphProviderSupport({
              ...common,
              globalGraphValidator: { ref: spec.graphComponent, validate },
              verifiedBuilds: builds as ReturnType<typeof createVerifiedNativeGlobalExactGraphBuild>[],
          });
}

function workflowGraph(spec: WorkflowVariantSpec, files: readonly RenderNativeRepresentationFileInput[]) {
    const file = files[0];
    if (files.length !== 1 || file?.contentKind !== "text" || !isWorkflowTargetPath(spec, file.relativePath)) {
        return null;
    }
    const parsed = splitCommand(file.text);
    if (file.executable || parsed === null || containsUnsupportedShellExpansion(parsed.body)) {
        return null;
    }
    return {
        graphIdentityRelativePath: file.relativePath,
        files: [{ nativeRelativePath: file.relativePath, canonicalLogicalPath: COMMAND_ENTRY }],
        managedDirectoryBoundaries: [],
    };
}

function isWorkflowTargetPath(spec: WorkflowVariantSpec, relativePath: PosixRelativePath): boolean {
    const segments = relativePath.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
    const prefixes = spec.scope === "project" ? [".zcode/commands/", ".agents/commands/"] : ["commands/"];
    return prefixes.some((prefix) => relativePath.startsWith(prefix)) && relativePath.endsWith(".md");
}

function rebaseCommand(input: NativeProjectExactGraphRebaseInput) {
    const parent = input.parent.files[0];
    const target = input.targetFiles[0];
    if (
        input.assetKind !== "Workflow" ||
        input.nativeDialectId !== ZCODE_NATIVE_DIALECTS.commandWorkflow ||
        input.targetCanonical.kind !== "Workflow" ||
        input.restorationInputs.length !== 0 ||
        input.parent.files.length !== 1 ||
        input.targetFiles.length !== 1 ||
        parent?.contentKind !== "text" ||
        target?.contentKind !== "text" ||
        parent.executable ||
        target.file.executable ||
        target.file.logicalPath !== COMMAND_ENTRY
    ) {
        return null;
    }
    const parsed = splitCommand(parent.text);
    if (parsed === null) return null;
    const parentDescriptor = nativeDescriptor(parent);
    if (
        !validateZcodeNativeDialect({
            canonical: input.targetCanonical,
            canonicalFiles: [{ ...target, text: parsed.body }],
            representation: { ...input.parent.representation, files: [parentDescriptor] },
            nativeFiles: [{ relativePath: parent.relativePath, bytes: new TextEncoder().encode(parent.text) }],
        })
    ) {
        return null;
    }
    return { nativeFiles: [textNativeFile(parent.relativePath, `${parsed.prefix}${target.text}${parsed.suffix}`, false)] };
}

function parseChangedCommand(input: ChangedNativeFileInput) {
    if (
        input.assetKind !== "Workflow" ||
        input.nativeDialectId !== ZCODE_NATIVE_DIALECTS.commandWorkflow ||
        input.appliedContent.contentKind !== "text" ||
        input.currentContent.contentKind !== "text"
    ) {
        return null;
    }
    const applied = splitCommand(input.appliedContent.text);
    const current = splitCommand(input.currentContent.text);
    if (
        applied === null ||
        current === null ||
        applied.prefix !== current.prefix ||
        applied.suffix !== current.suffix ||
        containsUnsupportedShellExpansion(current.body) ||
        !sameTextList(commandArgumentNames(applied.body), commandArgumentNames(current.body)) ||
        (hasExplicitDescription(applied.parsed) === false &&
            fallbackDescription(applied.body) !== fallbackDescription(current.body))
    ) {
        return null;
    }
    return { canonicalContent: { contentKind: "text" as const, text: current.body } };
}

interface ChangedNativeFileInput {
    assetKind: "Rule" | "Workflow" | "Skill" | "Subagent";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}

function splitCommand(text: string) {
    const parsed = parseZcodeCommandFrontmatter(text);
    if ((parsed.hasFrontmatter && (!parsed.closed || parsed.diagnostics.length !== 0)) || parsed.body.trim() === "") return null;
    const body = parsed.body.trim();
    const bodyStart = parsed.body.indexOf(body);
    if (bodyStart < 0) return null;
    const frontmatterLength = text.length - parsed.body.length;
    return {
        parsed,
        prefix: text.slice(0, frontmatterLength + bodyStart),
        body,
        suffix: parsed.body.slice(bodyStart + body.length),
    };
}

function hasExplicitDescription(parsed: ReturnType<typeof parseZcodeCommandFrontmatter>): boolean {
    const value = parsed.values.description;
    return parsed.presentKeys.includes("description") && typeof value === "string" && value.trim() !== "";
}

function textNativeFile(
    relativePath: PosixRelativePath,
    text: string,
    executable: boolean,
): Extract<RenderNativeRepresentationFileInput, { contentKind: "text" }> {
    const bytes = new TextEncoder().encode(text);
    return {
        relativePath,
        contentKind: "text",
        mediaType: "text/markdown",
        executable,
        contentHash: sha256SourceBytes(bytes),
        byteSize: bytes.byteLength,
        text,
    };
}

function nativeDescriptor(file: RenderNativeRepresentationFileInput) {
    if (file.contentKind !== "text") throw new Error("ZCode Workflow native file must be text");
    const { text: _text, ...descriptor } = file;
    return descriptor;
}

export async function analyzeZcodeWorkflowTargets(
    input: RenderAnalysisInput,
    supports: ZcodeWorkflowTargetSupports,
): Promise<AdapterRenderAnalysisResult> {
    const results: AdapterRenderAnalysisResult[] = [];
    const classified = new Set<string>();
    const assets = new Map(input.deployment.assets.map((asset) => [versionKey(asset.version.ref), asset]));
    for (const spec of VARIANTS) {
        const support = supports[spec.key];
        const keys = new Set(
            input.dialectInputs
                .filter(
                    (entry) =>
                        assets.get(versionKey(entry.targetVersion))?.scope === spec.scope &&
                        entry.inputs.some(
                            (candidate) =>
                                candidate.inputKind === "native_representation" &&
                                candidate.representation.dialectId === ZCODE_NATIVE_DIALECTS.commandWorkflow,
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
            appendZcodeBuildCompatibilityWarning(await support.analyze(projected), projected, support.renderContractDeclaration),
        );
    }
    const unclassified = input.requiredSemantics.filter((semantic) => !classified.has(versionKey(semantic.subject)));
    if (unclassified.length > 0) {
        const scriptVersions = new Set(
            input.dialectInputs
                .filter((entry) =>
                    entry.inputs.some(
                        (candidate) =>
                            candidate.inputKind === "native_representation" &&
                            candidate.representation.dialectId === ZCODE_NATIVE_DIALECTS.scriptWorkflow,
                    ),
                )
                .map((entry) => versionKey(entry.targetVersion)),
        );
        const missingNative = diagnostic(
            "render",
            "zcode_workflow_native_variant_unavailable",
            "ZCode Workflow target requires one scope-matched Markdown-command native lineage",
            "unsupported",
            "error",
        );
        const scriptUnsupported = diagnostic(
            "render",
            "zcode_script_workflow_target_unsupported_current_app_consumer_absent",
            "ZCode App 3.5.3 preserves JavaScript Workflow source files, but its App Command service loads only Markdown commands and the packaged CLI cannot resolve its optional TUI consumer; source import and exact native preservation remain available",
            "unsupported",
            "error",
        );
        const blockedSemanticRefs = unclassified.map((semantic) => {
            const item = scriptVersions.has(versionKey(semantic.subject)) ? scriptUnsupported : missingNative;
            return {
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                reasonCode: item.code,
                diagnostics: [item],
            };
        });
        const diagnostics = [
            ...(blockedSemanticRefs.some((blocked) => blocked.reasonCode === missingNative.code) ? [missingNative] : []),
            ...(blockedSemanticRefs.some((blocked) => blocked.reasonCode === scriptUnsupported.code) ? [scriptUnsupported] : []),
        ];
        results.push({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs,
            diagnostics,
        });
    }
    return explainModelInvocationRefusal(input, mergeAnalysis(input, results));
}

function mergeAnalysis(input: RenderAnalysisInput, results: readonly AdapterRenderAnalysisResult[]): AdapterRenderAnalysisResult {
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
            "zcode_workflow_variant_closure_invalid",
            "ZCode Workflow target variants did not classify one exact semantic closure",
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

function sameTextList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/** Markdown commands cannot preserve an instruction Workflow's model invocation. */
function explainModelInvocationRefusal(
    input: RenderAnalysisInput,
    result: AdapterRenderAnalysisResult,
): AdapterRenderAnalysisResult {
    const issue = diagnostic(
        "render",
        "zcode_workflow_model_invocation_unsupported",
        "ZCode Markdown commands cannot preserve model-initiated Workflow invocation; this asset cannot be deployed to this target",
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
