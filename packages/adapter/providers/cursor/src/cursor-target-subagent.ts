/** Exact Cursor Agent CLI/App project Markdown Subagent target. */

import { defineDialectComponentV1 as component, sha256SourceBytes, stableSourceValueEqual } from "@oaam/adapter-framework";
import {
    type AdapterRenderAnalysisResult,
    type CanonicalRenderEntryValidationInput,
    type AgentRuntimeDescriptor,
    createNativeProjectExactGraphProviderSupport,
    createVerifiedNativeProjectExactGraphBuild,
    type NativeProjectExactGraphCanonicalMaterializationInput,
    type NativeProjectExactGraphProviderSupport,
    type NativeProjectExactGraphRebaseInput,
    type PosixRelativePath,
    type RenderAnalysisInput,
    type RenderNativeRepresentationFileInput,
} from "@oaam/core/adapter-spi";
import { parseCursorFrontmatter } from "./cursor-frontmatter";
import { CURSOR_NATIVE_DIALECTS } from "./cursor-source-read-model";
import { isCursorSubagentPath, validateCursorNativeDialect } from "./cursor-source-read-native";
import {
    projectCursorMarkdownSubagentCanonical,
    rebaseCursorMarkdownSubagent,
    reverseCursorMarkdownSubagent,
    serializeCursorMarkdownSubagent,
} from "./cursor-subagent-markdown";
import {
    appendCursorBuildCompatibilityWarning,
    CURSOR_AGENT_TARGET_BUILD_COMPATIBILITY,
} from "./cursor-target-build-compatibility";

const PROJECT_FACTS = { "oaam.project-binding": "registered" } as const;
const ENTRY_PATH = "instructions.json" as PosixRelativePath;
const CANONICAL_DEGRADATIONS = ["runtime_specific_metadata_lost"] as const;

interface CursorSubagentRuntimeSpec {
    agentRuntimeId: "CURSOR_AGENT_CLI" | "CURSOR_APP";
    profileId: string;
    capabilityKey: string;
    outputContractId: string;
    targetPath: PosixRelativePath;
    loadMarker: string;
    builds: readonly {
        versionText: string;
        buildIdentity: `sha256:${string}`;
        platform: "linux" | "win32" | "wsl";
        fixturePrefix: string;
    }[];
}

const CLI_SPEC: CursorSubagentRuntimeSpec = {
    agentRuntimeId: "CURSOR_AGENT_CLI",
    profileId: "cursor-agent-cli-project-subagent-v1",
    capabilityKey: "cursor.project-subagent-markdown-v1",
    outputContractId: "CURSOR_AGENT_CLI_NATIVE_PROJECT_SUBAGENT_V1",
    targetPath: ".cursor/agents/oaam-phase58-subagent.md" as PosixRelativePath,
    loadMarker: "OAAM_CURSOR_SUBAGENT_20260723_7D31B9",
    builds: [
        {
            versionText: "2026.07.23-e383d2b",
            buildIdentity: "sha256:eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831",
            platform: "wsl",
            fixturePrefix: "cursor-agent-cli-2026.07.23-wsl",
        },
    ],
};

const APP_SPEC: CursorSubagentRuntimeSpec = {
    agentRuntimeId: "CURSOR_APP",
    profileId: "cursor-app-project-subagent-v1",
    capabilityKey: "cursor.app-project-subagent-markdown-v1",
    outputContractId: "CURSOR_APP_NATIVE_PROJECT_SUBAGENT_V1",
    targetPath: ".cursor/agents/oaam-app-subagent.md" as PosixRelativePath,
    loadMarker: "OAAM_CURSOR_APP_SUBAGENT_6D20",
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
        },
    ],
};

export const CURSOR_SUBAGENT_TARGET_COMPONENTS = {
    graph: component("cursor.project-subagent-markdown-one-file-v1"),
    reverse: component(`${CURSOR_NATIVE_DIALECTS.subagent}.native-to-canonical-parser`),
    rebase: component("cursor.subagent-markdown-parent-native-rebase-v1"),
    canonical: component("cursor.project-subagent-reviewed-canonical-materialization-v1"),
} as const;

export function createCursorCliSubagentTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    projectTargetContextSchemaId: string;
}): NativeProjectExactGraphProviderSupport {
    return createSubagentTargetSupport(CLI_SPEC, input);
}

export function createCursorAppSubagentTargetSupport(
    input: Parameters<typeof createCursorCliSubagentTargetSupport>[0],
): NativeProjectExactGraphProviderSupport {
    return createSubagentTargetSupport(APP_SPEC, input);
}

function createSubagentTargetSupport(
    spec: CursorSubagentRuntimeSpec,
    input: Parameters<typeof createCursorCliSubagentTargetSupport>[0],
): NativeProjectExactGraphProviderSupport {
    const canonicalDeclaration = {
        materializer: CURSOR_SUBAGENT_TARGET_COMPONENTS.canonical,
        degradationKinds: [...CANONICAL_DEGRADATIONS] as ["runtime_specific_metadata_lost"],
        reasonCode: "cursor_subagent_reviewed_canonical_conversion",
    };
    return createNativeProjectExactGraphProviderSupport({
        adapterId: "CURSOR",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: "Subagent",
        nativeDialectId: CURSOR_NATIVE_DIALECTS.subagent,
        outputContractId: spec.outputContractId,
        materializationProfileId: spec.profileId,
        materializerCapabilityKey: spec.capabilityKey,
        projectGraphValidator: {
            ref: CURSOR_SUBAGENT_TARGET_COMPONENTS.graph,
            project: oneFileGraph,
        },
        reverseParser: {
            ref: CURSOR_SUBAGENT_TARGET_COMPONENTS.reverse,
            parse: parseChangedFile,
        },
        rebaseMaterializer: {
            ref: CURSOR_SUBAGENT_TARGET_COMPONENTS.rebase,
            materialize: materializeParent,
        },
        canonicalMaterializer: {
            ref: CURSOR_SUBAGENT_TARGET_COMPONENTS.canonical,
            degradationKinds: [...CANONICAL_DEGRADATIONS],
            reasonCode: canonicalDeclaration.reasonCode,
            diagnosticMessage:
                "OAAM can map the portable Cursor Subagent behavior; source-only comments and layout stay native to Cursor",
            materialize: materializeCanonical,
            validateEntry: validateCanonicalEntry,
        },
        restorationDialectIds: [],
        buildCompatibility: CURSOR_AGENT_TARGET_BUILD_COMPATIBILITY,
        target: { targetContextSchemaId: input.projectTargetContextSchemaId, requiredFacts: PROJECT_FACTS },
        verifiedBuilds: spec.builds.map((build) =>
            createVerifiedNativeProjectExactGraphBuild({
                agentRuntimeId: spec.agentRuntimeId,
                versionText: build.versionText,
                buildIdentity: build.buildIdentity,
                platform: build.platform,
                materializationProfileId: spec.profileId,
                fixtureId: `${build.fixturePrefix}-project-subagent-2026-08-09`,
                assetKind: "Subagent",
                nativeDialectId: CURSOR_NATIVE_DIALECTS.subagent,
                reverseParser: CURSOR_SUBAGENT_TARGET_COMPONENTS.reverse,
                rebaseMaterializer: CURSOR_SUBAGENT_TARGET_COMPONENTS.rebase,
                canonicalMaterialization: canonicalDeclaration,
                restorationDialectIds: [],
                parentRebaseFixtureId: `${build.fixturePrefix}-project-subagent-parent-rebase-v1`,
                projectGraphValidator: CURSOR_SUBAGENT_TARGET_COMPONENTS.graph,
                targetGraphIdentity: spec.targetPath,
                targetRelativePaths: [spec.targetPath],
                exactLoadMarker: spec.loadMarker,
                reverseFixtureId: `${build.fixturePrefix}-project-subagent-body-reverse-v1`,
            }),
        ),
    });
}

export function analyzeCursorSubagentTarget(
    input: RenderAnalysisInput,
    support: NativeProjectExactGraphProviderSupport,
): Promise<AdapterRenderAnalysisResult> {
    return Promise.resolve(
        appendCursorBuildCompatibilityWarning(support.analyze(input), input, support.renderContractDeclaration),
    );
}

function oneFileGraph(files: readonly RenderNativeRepresentationFileInput[]) {
    const file = files[0];
    return files.length === 1 && file?.contentKind === "text" && !file.executable && isCursorSubagentPath(file.relativePath)
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
        input.nativeDialectId !== CURSOR_NATIVE_DIALECTS.subagent ||
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
    const projection = projectCursorMarkdownSubagentCanonical(input.targetCanonical, target.text);
    if (projection === null) return null;
    const text = rebaseCursorMarkdownSubagent(parent.text, projection);
    if (text === null) return null;
    const nativeFiles = [textNativeFile(parent.relativePath, text)];
    return validatesRebasedGraph(input, nativeFiles) ? { nativeFiles } : null;
}

function validateCanonicalEntry(input: CanonicalRenderEntryValidationInput): boolean {
    if (
        input.canonical.kind !== "Subagent" ||
        input.nativeDialectId !== CURSOR_NATIVE_DIALECTS.subagent ||
        input.canonicalEntry.contentKind !== "text" ||
        input.nativeEntry.content.contentKind !== "text" ||
        input.targetScope !== "project" ||
        input.nativeEntry.relativePath !== `.cursor/agents/oaam-subagent-${input.targetVersion.assetId.slice(0, 8)}.md`
    )
        return false;
    const projection = projectCursorMarkdownSubagentCanonical(input.canonical, input.canonicalEntry.text);
    if (projection === null) return false;
    const expected = Object.fromEntries(
        Object.entries({
            name: projection.name,
            description: projection.description,
            tools: projection.tools?.join(", "),
            model: projection.model,
            readonly: projection.readonly,
            background: projection.background,
        }).filter(([, value]) => value !== undefined),
    );
    const parsed = parseCursorFrontmatter(input.nativeEntry.content.text);
    return (
        parsed.hasFrontmatter &&
        parsed.closed &&
        parsed.diagnostics.length === 0 &&
        parsed.body === projection.body &&
        stableSourceValueEqual(parsed.values, expected)
    );
}

function materializeCanonical(input: NativeProjectExactGraphCanonicalMaterializationInput) {
    const target = input.targetFiles[0];
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== CURSOR_NATIVE_DIALECTS.subagent ||
        input.targetCanonical.kind !== "Subagent" ||
        input.targetScope !== "project" ||
        input.restorationInputs.length !== 0 ||
        input.targetFiles.length !== 1 ||
        target?.contentKind !== "text" ||
        target.file.logicalPath !== ENTRY_PATH ||
        target.file.executable
    ) {
        return null;
    }
    const projection = projectCursorMarkdownSubagentCanonical(input.targetCanonical, target.text);
    if (projection === null) return null;
    return {
        nativeFiles: [
            textNativeFile(
                `.cursor/agents/oaam-subagent-${input.targetVersion.assetId.slice(0, 8)}.md` as PosixRelativePath,
                serializeCursorMarkdownSubagent(projection),
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
        input.nativeDialectId !== CURSOR_NATIVE_DIALECTS.subagent ||
        input.appliedContent.contentKind !== "text" ||
        input.currentContent.contentKind !== "text"
    ) {
        return null;
    }
    const canonical = reverseCursorMarkdownSubagent(input.appliedContent.text, input.currentContent.text);
    return canonical === null ? null : { canonicalContent: { contentKind: "text" as const, text: canonical } };
}

function validatesRebasedGraph(
    input: NativeProjectExactGraphRebaseInput,
    nativeFiles: RenderNativeRepresentationFileInput[],
): boolean {
    return validateCursorNativeDialect({
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
