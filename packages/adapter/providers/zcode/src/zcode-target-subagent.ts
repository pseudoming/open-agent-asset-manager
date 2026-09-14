/** ZCode App project/global Markdown Subagent targets over the exact native graph contract. */

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
    type NativeProjectExactGraphRebaseMaterializer,
    type PosixRelativePath,
    type RenderAnalysisInput,
    type RenderNativeRepresentationFileInput,
} from "@oaam/core/adapter-spi";
import {
    projectZcodeMarkdownSubagentCanonical,
    rebaseZcodeMarkdownSubagent,
    reverseZcodeMarkdownSubagent,
    serializeZcodeMarkdownSubagent,
    type ZcodeSubagentScope,
} from "./zcode-subagent-markdown";
import { parseZcodeSubagentFrontmatter } from "./zcode-frontmatter";
import { ZCODE_NATIVE_DIALECTS } from "./zcode-source-read-model";
import { validateZcodeNativeDialect } from "./zcode-source-read-native";
import {
    appendZcodeBuildCompatibilityWarning,
    ZCODE_APP_SUBAGENT_TARGET_BUILD_COMPATIBILITY,
} from "./zcode-target-build-compatibility";
import { ZCODE_CURRENT_TARGET_BUILD, ZCODE_HISTORICAL_SUBAGENT_FLOOR } from "./zcode-target-builds";

const PROJECT_FACTS = { "oaam.project-binding": "registered" } as const;
const GLOBAL_FACTS = { "oaam.target-kind": "global" } as const;
const ENTRY_PATH = "instructions.json" as PosixRelativePath;
const CANONICAL_DEGRADATIONS = ["runtime_specific_metadata_lost"] as const;

export const ZCODE_SUBAGENT_TARGET_COMPONENTS = {
    project: component("zcode.project-subagent-markdown-one-file-v1"),
    global: component("zcode.global-subagent-markdown-one-file-v1"),
    reverse: component(`${ZCODE_NATIVE_DIALECTS.subagent}.native-to-canonical-parser`),
    rebase: component("zcode.subagent-markdown-parent-native-rebase-v1"),
    projectCanonical: component("zcode.project-subagent-reviewed-canonical-materialization-v1"),
    globalCanonical: component("zcode.global-subagent-reviewed-canonical-materialization-v1"),
} as const;

export interface ZcodeSubagentTargetSupports {
    project: NativeProjectExactGraphProviderSupport;
    global: NativeGlobalExactGraphProviderSupport;
}

interface SubagentVariantSpec {
    key: keyof ZcodeSubagentTargetSupports;
    scope: ZcodeSubagentScope;
    targetPath: PosixRelativePath;
    graphComponent: (typeof ZCODE_SUBAGENT_TARGET_COMPONENTS)["project" | "global"];
    canonicalComponent: (typeof ZCODE_SUBAGENT_TARGET_COMPONENTS)["projectCanonical" | "globalCanonical"];
    outputContractId: string;
    materializationProfileId: string;
    materializerCapabilityKey: string;
    fixtureSlug: string;
    loadMarker: string;
}

const VARIANTS: readonly SubagentVariantSpec[] = [
    {
        key: "project",
        scope: "project",
        targetPath: ".zcode/agents/oaam-phase56-subagent.md" as PosixRelativePath,
        graphComponent: ZCODE_SUBAGENT_TARGET_COMPONENTS.project,
        canonicalComponent: ZCODE_SUBAGENT_TARGET_COMPONENTS.projectCanonical,
        outputContractId: "ZCODE_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1",
        materializationProfileId: "zcode-app-project-subagent-markdown-v1",
        materializerCapabilityKey: "zcode.project-subagent-markdown-v1",
        fixtureSlug: "project-subagent-markdown",
        loadMarker: "OAAM_ZCODE_353_PROJECT_SUBAGENT_5C91D2",
    },
    {
        key: "global",
        scope: "global",
        targetPath: "agents/oaam-phase56-global-subagent.md" as PosixRelativePath,
        graphComponent: ZCODE_SUBAGENT_TARGET_COMPONENTS.global,
        canonicalComponent: ZCODE_SUBAGENT_TARGET_COMPONENTS.globalCanonical,
        outputContractId: "ZCODE_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1",
        materializationProfileId: "zcode-app-global-subagent-markdown-v1",
        materializerCapabilityKey: "zcode.global-subagent-markdown-v1",
        fixtureSlug: "global-subagent-markdown",
        loadMarker: "OAAM_ZCODE_353_GLOBAL_SUBAGENT_8E47A1",
    },
];

export function createZcodeSubagentTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
    globalTargetContextSchemaId: string;
}): ZcodeSubagentTargetSupports {
    return Object.fromEntries(
        VARIANTS.map((spec) => [spec.key, createVariantSupport(spec, input)]),
    ) as unknown as ZcodeSubagentTargetSupports;
}

function createVariantSupport(
    spec: SubagentVariantSpec,
    input: {
        adapterVersion: string;
        agentRuntimes: readonly AgentRuntimeDescriptor[];
        projectTargetContextSchemaId: string;
        globalTargetContextSchemaId: string;
    },
): NativeProjectExactGraphProviderSupport | NativeGlobalExactGraphProviderSupport {
    const canonicalDeclaration = {
        materializer: spec.canonicalComponent,
        degradationKinds: [...CANONICAL_DEGRADATIONS] as ["runtime_specific_metadata_lost"],
        reasonCode: "zcode_subagent_reviewed_canonical_conversion",
    };
    const buildSpecs = [
        ...(["wsl", "win32"] as const).map((platform) => ({
            versionText: ZCODE_CURRENT_TARGET_BUILD.versionText,
            buildIdentity: ZCODE_CURRENT_TARGET_BUILD.buildIdentity,
            platform,
            fixtureSuffix: "2026-08-08",
            loadMarker: spec.loadMarker,
        })),
        {
            ...ZCODE_HISTORICAL_SUBAGENT_FLOOR,
            fixtureSuffix: "historical-lifecycle-2026-08-17",
            loadMarker: `OAAM_ZCODE_HISTORICAL_${spec.key.toUpperCase()}_SUBAGENT_3_2_1`,
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
            assetKind: "Subagent" as const,
            nativeDialectId: ZCODE_NATIVE_DIALECTS.subagent,
            reverseParser: ZCODE_SUBAGENT_TARGET_COMPONENTS.reverse,
            rebaseMaterializer: ZCODE_SUBAGENT_TARGET_COMPONENTS.rebase,
            canonicalMaterialization: canonicalDeclaration,
            restorationDialectIds: [],
            parentRebaseFixtureId: `zcode-app-${buildSpec.versionText}-${buildSpec.platform}-${spec.fixtureSlug}-parent-rebase-v1`,
            targetGraphIdentity: spec.targetPath,
            targetRelativePaths: [spec.targetPath],
            exactLoadMarker: buildSpec.loadMarker,
            reverseFixtureId: `zcode-app-${buildSpec.versionText}-${buildSpec.platform}-${spec.fixtureSlug}-body-reverse-v1`,
        };
        return spec.scope === "project"
            ? createVerifiedNativeProjectExactGraphBuild({ ...common, projectGraphValidator: spec.graphComponent })
            : createVerifiedNativeGlobalExactGraphBuild({ ...common, globalGraphValidator: spec.graphComponent });
    });
    const canonicalMaterializer: NativeProjectExactGraphCanonicalMaterializer = {
        ref: spec.canonicalComponent,
        degradationKinds: [...CANONICAL_DEGRADATIONS],
        reasonCode: "zcode_subagent_reviewed_canonical_conversion",
        diagnosticMessage:
            "OAAM can map the portable Subagent behavior, while source-only comments and layout remain native to the source runtime",
        materialize: (materializationInput) => materializeCanonical(materializationInput, spec),
        validateEntry: (value) => validateCanonicalEntry(value, spec),
    };
    const common = {
        adapterId: "ZCODE" as const,
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: "ZCODE_APP" as const,
        assetKind: "Subagent" as const,
        nativeDialectId: ZCODE_NATIVE_DIALECTS.subagent,
        reverseParser: {
            ref: ZCODE_SUBAGENT_TARGET_COMPONENTS.reverse,
            parse: parseChangedFile,
        },
        rebaseMaterializer: REBASE_MATERIALIZER,
        canonicalMaterializer,
        restorationDialectIds: [],
        buildCompatibility: ZCODE_APP_SUBAGENT_TARGET_BUILD_COMPATIBILITY,
    };
    if (spec.scope === "project") {
        return createNativeProjectExactGraphProviderSupport({
            ...common,
            outputContractId: spec.outputContractId,
            materializationProfileId: spec.materializationProfileId,
            materializerCapabilityKey: spec.materializerCapabilityKey,
            projectGraphValidator: { ref: spec.graphComponent, project: (files) => oneFileGraph(files, spec) },
            target: { targetContextSchemaId: input.projectTargetContextSchemaId, requiredFacts: PROJECT_FACTS },
            verifiedBuilds: builds as ReturnType<typeof createVerifiedNativeProjectExactGraphBuild>[],
        });
    }
    return createNativeGlobalExactGraphProviderSupport({
        ...common,
        outputContractId: spec.outputContractId,
        materializationProfileId: spec.materializationProfileId,
        materializerCapabilityKey: spec.materializerCapabilityKey,
        globalGraphValidator: { ref: spec.graphComponent, validate: (files) => oneFileGraph(files, spec) },
        target: { targetContextSchemaId: input.globalTargetContextSchemaId, requiredFacts: GLOBAL_FACTS },
        verifiedBuilds: builds as ReturnType<typeof createVerifiedNativeGlobalExactGraphBuild>[],
    });
}

const REBASE_MATERIALIZER: NativeProjectExactGraphRebaseMaterializer = {
    ref: ZCODE_SUBAGENT_TARGET_COMPONENTS.rebase,
    materialize: materializeParent,
};

function oneFileGraph(files: readonly RenderNativeRepresentationFileInput[], spec: SubagentVariantSpec) {
    const file = files[0];
    return files.length === 1 &&
        file?.contentKind === "text" &&
        !file.executable &&
        isSubagentTargetPath(file.relativePath, spec.scope)
        ? {
              graphIdentityRelativePath: file.relativePath,
              files: [{ nativeRelativePath: file.relativePath, canonicalLogicalPath: ENTRY_PATH }],
              managedDirectoryBoundaries: [],
          }
        : null;
}

function materializeParent(input: NativeProjectExactGraphRebaseInput) {
    const parent = input.parent.files[0];
    const target = input.targetFiles[0];
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== ZCODE_NATIVE_DIALECTS.subagent ||
        input.targetCanonical.kind !== "Subagent" ||
        input.restorationInputs.length !== 0 ||
        input.parent.files.length !== 1 ||
        input.targetFiles.length !== 1 ||
        parent?.contentKind !== "text" ||
        parent.executable ||
        target?.contentKind !== "text" ||
        target.file.logicalPath !== ENTRY_PATH ||
        target.file.executable
    ) {
        return null;
    }
    const scope = scopeForPath(parent.relativePath);
    if (scope === null) return null;
    const projection = projectZcodeMarkdownSubagentCanonical(input.targetCanonical, target.text, scope);
    if (projection === null) return null;
    const text = rebaseZcodeMarkdownSubagent(parent.text, projection, scope);
    if (text === null) return null;
    const nativeFiles = [textNativeFile(parent.relativePath, text)];
    return validatesRebasedGraph(input, nativeFiles) ? { nativeFiles } : null;
}

function validateCanonicalEntry(input: CanonicalRenderEntryValidationInput, spec: SubagentVariantSpec): boolean {
    if (
        input.canonical.kind !== "Subagent" ||
        input.nativeDialectId !== ZCODE_NATIVE_DIALECTS.subagent ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text" ||
        input.targetScope !== spec.scope ||
        input.nativeEntry.relativePath !== canonicalTargetPath(spec, input.targetVersion.assetId.slice(0, 8))
    )
        return false;
    const projection = projectZcodeMarkdownSubagentCanonical(input.canonical, input.canonicalEntry.text, spec.scope);
    if (projection === null) return false;
    const expected = Object.fromEntries(
        Object.entries({
            name: projection.name,
            description: projection.description,
            tools: projection.tools,
            disallowedTools: projection.disallowedTools,
            model: projection.model,
            permissionMode: projection.permissionMode,
            maxTurns: projection.maxTurns,
            background: projection.background,
            color: projection.color,
        }).filter(([, value]) => value !== undefined),
    );
    const parsed = parseZcodeSubagentFrontmatter(input.nativeEntry.content.text);
    return (
        parsed.hasFrontmatter &&
        parsed.closed &&
        parsed.diagnostics.length === 0 &&
        parsed.body === projection.body &&
        stableSourceValueEqual(parsed.values, expected)
    );
}

function materializeCanonical(
    input: NativeProjectExactGraphCanonicalMaterializationInput,
    spec: SubagentVariantSpec,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    const target = input.targetFiles[0];
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== ZCODE_NATIVE_DIALECTS.subagent ||
        input.targetCanonical.kind !== "Subagent" ||
        input.targetScope !== spec.scope ||
        input.restorationInputs.length !== 0 ||
        input.targetFiles.length !== 1 ||
        target?.contentKind !== "text" ||
        target.file.logicalPath !== ENTRY_PATH ||
        target.file.executable
    ) {
        return null;
    }
    const projection = projectZcodeMarkdownSubagentCanonical(input.targetCanonical, target.text, spec.scope);
    if (projection === null) return null;
    return {
        nativeFiles: [
            textNativeFile(
                canonicalTargetPath(spec, input.targetVersion.assetId.slice(0, 8)),
                serializeZcodeMarkdownSubagent(projection),
            ),
        ],
    };
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
        input.nativeDialectId !== ZCODE_NATIVE_DIALECTS.subagent ||
        input.appliedContent.contentKind !== "text" ||
        input.currentContent.contentKind !== "text"
    ) {
        return null;
    }
    const canonical = reverseZcodeMarkdownSubagent(input.appliedContent.text, input.currentContent.text);
    return canonical === null ? null : { canonicalContent: { contentKind: "text" as const, text: canonical } };
}

export async function analyzeZcodeSubagentTargets(
    input: RenderAnalysisInput,
    supports: ZcodeSubagentTargetSupports,
): Promise<AdapterRenderAnalysisResult> {
    const results: AdapterRenderAnalysisResult[] = [];
    const classified = new Set<string>();
    for (const spec of VARIANTS) {
        const support = supports[spec.key];
        const keys = new Set(
            input.deployment.assets.filter((asset) => asset.scope === spec.scope).map((asset) => versionKey(asset.version.ref)),
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
        const issue = diagnostic(
            "render",
            "zcode_subagent_scope_unavailable",
            "ZCode Subagent target requires one project or global declaration scope",
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
        const issue = diagnostic(
            "render",
            "zcode_subagent_variant_closure_invalid",
            "ZCode Subagent targets did not classify one exact semantic closure",
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

function textNativeFile(relativePath: PosixRelativePath, text: string) {
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

function isSubagentTargetPath(relativePath: PosixRelativePath, scope: ZcodeSubagentScope): boolean {
    const segments = relativePath.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
    if (!relativePath.toLowerCase().match(/\.(md|markdown)$/u)) return false;
    return scope === "project" ? relativePath.startsWith(".zcode/agents/") : relativePath.startsWith("agents/");
}

function scopeForPath(relativePath: PosixRelativePath): ZcodeSubagentScope | null {
    if (relativePath.startsWith(".zcode/agents/")) return "project";
    if (relativePath.startsWith("agents/")) return "global";
    return null;
}

function canonicalTargetPath(spec: SubagentVariantSpec, assetPrefix: string): PosixRelativePath {
    const slash = spec.targetPath.lastIndexOf("/");
    return `${spec.targetPath.slice(0, slash + 1)}oaam-subagent-${assetPrefix}.md` as PosixRelativePath;
}

function versionKey(ref: { assetId: string; versionId: string }): string {
    return `${ref.assetId}\0${ref.versionId}`;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
