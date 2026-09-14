/** Exact OpenCode CLI/App project/global Markdown Subagent targets. */

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
    type SubagentToolPermissionRuleV2,
    type SubagentTypeDataV2,
} from "@oaam/core/adapter-spi";
import { parseOpencodeFrontmatter } from "./opencode-frontmatter";
import {
    COLOR_DIALECT,
    MODEL_DIALECT,
    OPENCODE_NATIVE_DIALECTS,
    TOOL_DIALECT,
    TURN_LIMIT_DIALECT,
    VARIANT_DIALECT,
} from "./opencode-source-read-model";
import { isOpencodeColor } from "./opencode-source-read-fields";
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

const ENTRY_NAME = "instructions.json" as PosixRelativePath;
const GLOBAL_FACTS = { "oaam.target-kind": "global" } as const;

type OpenCodeSubagentRuntimeId = "OPENCODE_CLI" | "OPENCODE_APP";

interface SubagentRuntimeSpec {
    agentRuntimeId: OpenCodeSubagentRuntimeId;
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
    projectFixtureName: "oaam-phase57-project-subagent",
    globalFixtureName: "oaam-phase57-global-subagent",
    projectLoadMarker: "oaam-phase57-project-subagent",
    globalLoadMarker: "oaam-phase57-global-subagent",
} as const satisfies SubagentRuntimeSpec;

const APP_SPEC = {
    agentRuntimeId: "OPENCODE_APP",
    profilePrefix: "opencode-app",
    capabilityPrefix: "opencode.app",
    outputPrefix: "OPENCODE_APP",
    targetBuilds: OPENCODE_APP_TARGET_BUILD_ANCHORS,
    projectFixtureName: "oaam-phase57-app-project-subagent",
    globalFixtureName: "oaam-phase57-app-global-subagent",
    projectLoadMarker: "oaam-phase57-app-project-subagent",
    globalLoadMarker: "oaam-phase57-app-global-subagent",
} as const satisfies SubagentRuntimeSpec;

export interface OpencodeSubagentTargetSupports {
    project: NativeProjectExactGraphProviderSupport;
    global: NativeGlobalExactGraphProviderSupport;
}

export const OPENCODE_SUBAGENT_TARGET_COMPONENTS = {
    project: component("opencode.project-subagent-markdown-one-file-v1"),
    global: component("opencode.global-subagent-markdown-one-file-v1"),
    reverse: component(`${OPENCODE_NATIVE_DIALECTS.subagent}.native-to-canonical-parser`),
    rebase: component("opencode.subagent-markdown-parent-native-rebase-v1"),
    canonical: component("opencode.subagent-markdown-reviewed-canonical-materialization-v1"),
} as const;

export function createOpencodeCliSubagentTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
}): OpencodeSubagentTargetSupports {
    return createSubagentTargetSupports(CLI_SPEC, input);
}

export function createOpencodeAppSubagentTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
}): OpencodeSubagentTargetSupports {
    return createSubagentTargetSupports(APP_SPEC, input);
}

function createSubagentTargetSupports(
    spec: SubagentRuntimeSpec,
    input: {
        adapterVersion: string;
        agentRuntimes: readonly AgentRuntimeDescriptor[];
        projectTargetContextSchemaId: string;
        globalTargetContextSchemaId: string;
    },
): OpencodeSubagentTargetSupports {
    const projectProfile = `${spec.profilePrefix}-project-subagent-markdown-v1`;
    const globalProfile = `${spec.profilePrefix}-global-subagent-markdown-v1`;
    const projectPath = `.opencode/agents/${spec.projectFixtureName}.md` as PosixRelativePath;
    const globalPath = `agents/${spec.globalFixtureName}.md` as PosixRelativePath;
    const canonicalMaterialization = {
        materializer: OPENCODE_SUBAGENT_TARGET_COMPONENTS.canonical,
        degradationKinds: ["runtime_specific_metadata_lost"] as ["runtime_specific_metadata_lost"],
        reasonCode: "opencode_subagent_reviewed_canonical_conversion",
    };
    const commonBuild = (build: OpencodeTargetBuildAnchor) => ({
        agentRuntimeId: spec.agentRuntimeId,
        versionText: build.versionText,
        buildIdentity: build.buildIdentity,
        platform: build.platform,
        assetKind: "Subagent" as const,
        nativeDialectId: OPENCODE_NATIVE_DIALECTS.subagent,
        reverseParser: OPENCODE_SUBAGENT_TARGET_COMPONENTS.reverse,
        rebaseMaterializer: OPENCODE_SUBAGENT_TARGET_COMPONENTS.rebase,
        canonicalMaterialization,
        restorationDialectIds: [] as string[],
    });
    const projectBuilds = spec.targetBuilds.map((build) =>
        createVerifiedNativeProjectExactGraphBuild({
            ...commonBuild(build),
            materializationProfileId: projectProfile,
            fixtureId: `${spec.profilePrefix}-1.18.15-${build.platform}-project-subagent-${build.fixtureDate}`,
            projectGraphValidator: OPENCODE_SUBAGENT_TARGET_COMPONENTS.project,
            parentRebaseFixtureId: `${spec.profilePrefix}-1.18.15-${build.platform}-project-subagent-parent-rebase-v1`,
            targetGraphIdentity: projectPath,
            targetRelativePaths: [projectPath],
            exactLoadMarker: spec.projectLoadMarker,
            reverseFixtureId: `${spec.profilePrefix}-1.18.15-${build.platform}-project-subagent-reverse-v1`,
        }),
    );
    const globalBuilds = spec.targetBuilds.map((build) =>
        createVerifiedNativeGlobalExactGraphBuild({
            ...commonBuild(build),
            materializationProfileId: globalProfile,
            fixtureId: `${spec.profilePrefix}-1.18.15-${build.platform}-global-subagent-${build.fixtureDate}`,
            globalGraphValidator: OPENCODE_SUBAGENT_TARGET_COMPONENTS.global,
            parentRebaseFixtureId: `${spec.profilePrefix}-1.18.15-${build.platform}-global-subagent-parent-rebase-v1`,
            targetGraphIdentity: globalPath,
            targetRelativePaths: [globalPath],
            exactLoadMarker: spec.globalLoadMarker,
            reverseFixtureId: `${spec.profilePrefix}-1.18.15-${build.platform}-global-subagent-reverse-v1`,
        }),
    );
    const common = {
        adapterId: "OPENCODE" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: "Subagent" as const,
        nativeDialectId: OPENCODE_NATIVE_DIALECTS.subagent,
        reverseParser: { ref: OPENCODE_SUBAGENT_TARGET_COMPONENTS.reverse, parse: parseChangedSubagent },
        rebaseMaterializer: { ref: OPENCODE_SUBAGENT_TARGET_COMPONENTS.rebase, materialize: materializeSubagentParent },
        canonicalMaterializer: OPENCODE_SUBAGENT_CANONICAL_MATERIALIZER,
        restorationDialectIds: [] as string[],
        buildCompatibility: OPENCODE_TARGET_BUILD_COMPATIBILITY,
    };
    return {
        project: createNativeProjectExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1`,
            materializationProfileId: projectProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-project-subagent-markdown-v1`,
            projectGraphValidator: {
                ref: OPENCODE_SUBAGENT_TARGET_COMPONENTS.project,
                project: (files) => subagentGraph(files, "project"),
            },
            target: { targetContextSchemaId: input.projectTargetContextSchemaId, requiredFacts: {} },
            verifiedBuilds: projectBuilds,
        }),
        global: createNativeGlobalExactGraphProviderSupport({
            ...common,
            outputContractId: `${spec.outputPrefix}_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1`,
            materializationProfileId: globalProfile,
            materializerCapabilityKey: `${spec.capabilityPrefix}-global-subagent-markdown-v1`,
            globalGraphValidator: {
                ref: OPENCODE_SUBAGENT_TARGET_COMPONENTS.global,
                validate: (files) => subagentGraph(files, "global"),
            },
            target: { targetContextSchemaId: input.globalTargetContextSchemaId, requiredFacts: GLOBAL_FACTS },
            verifiedBuilds: globalBuilds,
        }),
    };
}

const OPENCODE_SUBAGENT_CANONICAL_MATERIALIZER: NativeProjectExactGraphCanonicalMaterializer = {
    ref: OPENCODE_SUBAGENT_TARGET_COMPONENTS.canonical,
    degradationKinds: ["runtime_specific_metadata_lost"],
    reasonCode: "opencode_subagent_reviewed_canonical_conversion",
    diagnosticMessage:
        "OAAM can write the portable Subagent fields; source-runtime private options remain preserved in the source Version but are not expressed in this target",
    materialize: materializeCanonicalSubagent,
    validateEntry: validateCanonicalSubagentEntry,
};

function validateCanonicalSubagentEntry(input: CanonicalRenderEntryValidationInput): boolean {
    if (
        input.canonical.kind !== "Subagent" ||
        input.nativeDialectId !== OPENCODE_NATIVE_DIALECTS.subagent ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text"
    )
        return false;
    const portable = portableSubagentData(input.canonical, input.canonicalEntry.text);
    if (
        portable === null ||
        input.nativeEntry.relativePath !==
            `${input.targetScope === "project" ? ".opencode/agents/" : "agents/"}${portable.typeData.name}.md`
    )
        return false;
    const expected = Object.fromEntries(
        Object.entries({
            description: portable.typeData.description,
            mode: portable.mode,
            model: portable.model,
            variant: portable.variant,
            temperature: portable.temperature,
            top_p: portable.topP,
            steps: portable.steps,
            hidden: portable.hidden ? true : undefined,
            color: portable.color,
            permission:
                portable.permission.length > 0
                    ? Object.fromEntries(portable.permission.map((rule) => [rule.selector, rule.action]))
                    : undefined,
        }).filter(([, value]) => value !== undefined),
    );
    const parsed = parseOpencodeFrontmatter(input.nativeEntry.content.text);
    return (
        parsed.hasFrontmatter &&
        parsed.closed &&
        parsed.diagnostics.length === 0 &&
        parsed.body === portable.body &&
        stableSourceValueEqual(parsed.values, expected)
    );
}

function materializeCanonicalSubagent(
    input: NativeProjectExactGraphCanonicalMaterializationInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    const portable = portableSubagent(input.targetCanonical, input.targetFiles);
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== OPENCODE_NATIVE_DIALECTS.subagent ||
        input.restorationInputs.length !== 0 ||
        portable === null
    ) {
        return null;
    }
    const prefix = input.targetScope === "project" ? ".opencode/agents/" : "agents/";
    const relativePath = `${prefix}${portable.typeData.name}.md` as PosixRelativePath;
    const lines = ["---", `description: ${JSON.stringify(portable.typeData.description)}`, `mode: ${portable.mode}`];
    if (portable.model !== undefined) lines.push(`model: ${JSON.stringify(portable.model)}`);
    if (portable.variant !== undefined) lines.push(`variant: ${JSON.stringify(portable.variant)}`);
    if (portable.temperature !== undefined) lines.push(`temperature: ${String(portable.temperature)}`);
    if (portable.topP !== undefined) lines.push(`top_p: ${String(portable.topP)}`);
    if (portable.steps !== undefined) lines.push(`steps: ${String(portable.steps)}`);
    if (portable.hidden) lines.push("hidden: true");
    if (portable.color !== undefined) lines.push(`color: ${JSON.stringify(portable.color)}`);
    if (portable.permission.length > 0) {
        lines.push("permission:");
        for (const rule of portable.permission) {
            lines.push(`  ${JSON.stringify(rule.selector)}: ${rule.action}`);
        }
    }
    lines.push("---", portable.body);
    return { nativeFiles: [textNativeFile(relativePath, lines.join("\n"))] };
}

function portableSubagent(
    canonical: NativeProjectExactGraphCanonicalMaterializationInput["targetCanonical"],
    files: NativeProjectExactGraphCanonicalMaterializationInput["targetFiles"],
): ReturnType<typeof portableSubagentData> {
    const entry = files[0];
    if (
        files.length !== 1 ||
        entry?.contentKind !== "text" ||
        entry.file.role !== "entry" ||
        entry.file.logicalPath !== ENTRY_NAME ||
        entry.file.executable
    )
        return null;
    return portableSubagentData(canonical, entry.text);
}

function portableSubagentData(
    canonical: NativeProjectExactGraphCanonicalMaterializationInput["targetCanonical"],
    entryText: string,
): {
    typeData: SubagentTypeDataV2;
    body: string;
    mode: "subagent" | "all";
    model: string | undefined;
    variant: string | undefined;
    temperature: number | undefined;
    topP: number | undefined;
    steps: number | undefined;
    hidden: boolean;
    color: string | undefined;
    permission: Array<{ selector: string; action: "allow" | "ask" | "deny" }>;
} | null {
    if (canonical.kind !== "Subagent") return null;
    const typeData = canonical.typeData;
    const body = instructionBody(entryText);
    const mode = portableMode(typeData);
    const model = portableTier(typeData.execution.model, MODEL_DIALECT);
    const variant = portableTier(typeData.execution.effort, VARIANT_DIALECT);
    const temperature = portableSampling(typeData.execution.sampling.temperature);
    const topP = portableSampling(typeData.execution.sampling.topP);
    const steps = portableTurnLimit(typeData);
    const color = portableColor(typeData);
    const permission = portablePermission(typeData.tools.permission.rules);
    if (
        body === null ||
        mode === null ||
        model === null ||
        variant === null ||
        temperature === null ||
        topP === null ||
        steps === null ||
        color === null ||
        permission === null ||
        !safeName(typeData.name) ||
        typeData.description.trim() === "" ||
        !stableSourceValueEqual(typeData.promptContextPolicy, { mode: "agent_runtime_default" }) ||
        !stableSourceValueEqual(typeData.tools.availability, {
            base: { mode: "inherit_available" },
            unavailable: [],
        }) ||
        typeData.tools.permission.otherwise !== "inherit_agent_runtime_policy" ||
        typeData.dependencies.preloadedSkillVersionIds.length !== 0 ||
        !stableSourceValueEqual(typeData.memory, { mode: "disabled" }) ||
        !stableSourceValueEqual(typeData.execution.permission, { mode: "inherit" }) ||
        !stableSourceValueEqual(typeData.execution.workspaceIsolation, { mode: "agent_runtime_default" }) ||
        !stableSourceValueEqual(typeData.execution.scheduling, { mode: "agent_runtime_default" }) ||
        (typeData.presentation.listing !== "agent_runtime_default" && typeData.presentation.listing !== "hidden")
    ) {
        return null;
    }
    return {
        typeData,
        body,
        mode,
        model,
        variant,
        temperature,
        topP,
        steps,
        hidden: typeData.presentation.listing === "hidden",
        color,
        permission,
    };
}

function portableMode(typeData: SubagentTypeDataV2): "subagent" | "all" | null {
    if (typeData.directInvocation.mode === "delegated_only") return "subagent";
    return typeData.directInvocation.mode === "user_selectable" && typeData.directInvocation.initialPrompt.mode === "none"
        ? "all"
        : null;
}

function portableTier(
    value: SubagentTypeDataV2["execution"]["model"] | SubagentTypeDataV2["execution"]["effort"],
    dialectId: string,
): string | undefined | null {
    if (value.mode === "inherit") return undefined;
    return value.dialectId === dialectId && value.relativeTier === -1 && safeScalar(value.selector) ? value.selector : null;
}

function portableSampling(value: SubagentTypeDataV2["execution"]["sampling"]["temperature"]): number | undefined | null {
    if (value.mode === "agent_runtime_default") return undefined;
    return Number.isFinite(value.value) ? value.value : null;
}

function portableTurnLimit(typeData: SubagentTypeDataV2): number | undefined | null {
    const value = typeData.execution.turnLimit;
    if (value.mode === "agent_runtime_default") return undefined;
    return value.dialectId === TURN_LIMIT_DIALECT && Number.isSafeInteger(value.limit) && value.limit > 0 ? value.limit : null;
}

function portableColor(typeData: SubagentTypeDataV2): string | undefined | null {
    const value = typeData.presentation.color;
    if (value.mode === "agent_runtime_default") return undefined;
    return value.dialectId === COLOR_DIALECT && isOpencodeColor(value.selector) ? value.selector : null;
}

function portablePermission(
    rules: readonly SubagentToolPermissionRuleV2[],
): Array<{ selector: string; action: "allow" | "ask" | "deny" }> | null {
    const result: Array<{ selector: string; action: "allow" | "ask" | "deny" }> = [];
    const seen = new Set<string>();
    for (const rule of rules) {
        if (
            rule.selector.mode !== "agent_runtime_tool" ||
            rule.selector.selector.dialectId !== TOOL_DIALECT ||
            !safeScalar(rule.selector.selector.selector) ||
            seen.has(rule.selector.selector.selector)
        ) {
            return null;
        }
        seen.add(rule.selector.selector.selector);
        result.push({
            selector: rule.selector.selector.selector,
            action: rule.action === "preapproved" ? "allow" : rule.action,
        });
    }
    return result;
}

function subagentGraph(files: readonly RenderNativeRepresentationFileInput[], scope: "project" | "global") {
    const file = files[0];
    if (
        files.length !== 1 ||
        file?.contentKind !== "text" ||
        file.executable ||
        !isSubagentPath(file.relativePath, scope) ||
        splitSubagentDocument(file.text) === null
    ) {
        return null;
    }
    return {
        graphIdentityRelativePath: file.relativePath,
        files: [{ nativeRelativePath: file.relativePath, canonicalLogicalPath: ENTRY_NAME }],
        managedDirectoryBoundaries: [],
    };
}

function materializeSubagentParent(
    input: NativeProjectExactGraphRebaseInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== OPENCODE_NATIVE_DIALECTS.subagent ||
        input.targetCanonical.kind !== "Subagent" ||
        input.restorationInputs.length !== 0 ||
        input.parent.files.length !== 1 ||
        input.targetFiles.length !== 1
    ) {
        return null;
    }
    const parent = input.parent.files[0];
    const target = input.targetFiles[0];
    const parentDocument = parent?.contentKind === "text" ? splitSubagentDocument(parent.text) : null;
    const targetBody = target?.contentKind === "text" ? instructionBody(target.text) : null;
    if (
        parent?.contentKind !== "text" ||
        target?.contentKind !== "text" ||
        parent.executable ||
        target.file.executable ||
        target.file.role !== "entry" ||
        target.file.logicalPath !== ENTRY_NAME ||
        parentDocument === null ||
        targetBody === null ||
        (subagentGraph(input.parent.files, "project") === null && subagentGraph(input.parent.files, "global") === null)
    ) {
        return null;
    }
    const { text: parentText, ...descriptor } = parent;
    const parentCanonicalText = instructionText(parentDocument.body);
    if (
        !validateOpencodeNativeDialect({
            canonical: input.targetCanonical,
            canonicalFiles: [{ ...target, text: parentCanonicalText }],
            representation: { ...input.parent.representation, files: [descriptor] },
            nativeFiles: [{ relativePath: parent.relativePath, bytes: new TextEncoder().encode(parentText) }],
        })
    ) {
        return null;
    }
    return { nativeFiles: [textNativeFile(parent.relativePath, `${parentDocument.prefix}${targetBody}`)] };
}

function parseChangedSubagent(input: {
    assetKind: "Rule" | "Workflow" | "Skill" | "Subagent";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}) {
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== OPENCODE_NATIVE_DIALECTS.subagent ||
        input.appliedContent.contentKind !== "text" ||
        input.currentContent.contentKind !== "text" ||
        (!isSubagentPath(input.relativePath, "project") && !isSubagentPath(input.relativePath, "global"))
    ) {
        return null;
    }
    const applied = splitSubagentDocument(input.appliedContent.text);
    const current = splitSubagentDocument(input.currentContent.text);
    return applied === null || current === null || applied.prefix !== current.prefix
        ? null
        : { canonicalContent: { contentKind: "text" as const, text: instructionText(current.body) } };
}

function splitSubagentDocument(text: string): { prefix: string; body: string } | null {
    const parsed = parseOpencodeFrontmatter(text);
    return parsed.hasFrontmatter && parsed.closed && parsed.diagnostics.length === 0 && parsed.body.trim() !== ""
        ? { prefix: text.slice(0, text.length - parsed.body.length), body: parsed.body.trim() }
        : null;
}

function instructionBody(text: string): string | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (!record(value) || Object.keys(value).sort().join("\0") !== "schemaVersion\0sections" || value.schemaVersion !== 1) {
        return null;
    }
    if (!Array.isArray(value.sections) || value.sections.length !== 1) return null;
    const section = value.sections[0];
    return record(section) &&
        Object.keys(section).sort().join("\0") === "content\0title" &&
        section.title === "" &&
        typeof section.content === "string" &&
        section.content.trim() !== ""
        ? section.content.trim()
        : null;
}

function instructionText(body: string): string {
    return JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: body.trim() }] });
}

function isSubagentPath(relativePath: PosixRelativePath, scope: "project" | "global"): boolean {
    if (relativePath.includes("\0") || relativePath.includes("\\") || !relativePath.endsWith(".md")) return false;
    const segments = relativePath.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
    const prefix = scope === "project" ? segments.slice(0, 2).join("/") : segments[0];
    return scope === "project"
        ? (prefix === ".opencode/agent" || prefix === ".opencode/agents") && segments.length >= 3
        : (prefix === "agent" || prefix === "agents") && segments.length >= 2;
}

function safeName(name: string): boolean {
    const segments = name.split("/");
    return name !== "" && !name.endsWith(".md") && segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment));
}

function safeScalar(value: string): boolean {
    return value.trim() !== "" && !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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

export async function analyzeOpencodeSubagentTargets(
    input: RenderAnalysisInput,
    supports: OpencodeSubagentTargetSupports,
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
                                    candidate.representation.dialectId === OPENCODE_NATIVE_DIALECTS.subagent) ||
                                (candidate.inputKind === "canonical_materialization" &&
                                    candidate.nativeDialectId === OPENCODE_NATIVE_DIALECTS.subagent),
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
            "opencode_subagent_native_variant_unavailable",
            "OpenCode Subagent target requires one scope-matched Markdown-agent native or reviewed canonical lineage",
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
    return mergeAnalysis(input, results);
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
            "opencode_subagent_variant_closure_invalid",
            "OpenCode Subagent target variants did not classify one exact semantic closure",
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

export const opencodeSubagentTargetInternalsForTest = {
    instructionBody,
    instructionText,
    isSubagentPath,
    mergeAnalysis,
    parseChangedSubagent,
    portableSubagent,
    splitSubagentDocument,
    subagentGraph,
};
