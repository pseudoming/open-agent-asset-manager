/** Codex one-file project Subagent targets over the Core exact-native contract. */

import { defineDialectComponentV1 as component, sha256SourceBytes } from "@oaam/adapter-framework";
import type { AgentRuntimeDescriptor, NativeProjectExactFileProviderSupport, PosixRelativePath } from "@oaam/core";
import { createNativeProjectExactFileProviderSupport, createVerifiedNativeProjectExactFileBuild } from "@oaam/core/adapter-spi";
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

type CodexExactRuntime = "CODEX_CLI" | "CODEX_APP";
type CodexExactAssetKind = "Subagent";
type ExactSupportInput = Parameters<typeof createNativeProjectExactFileProviderSupport>[0];
type ExactRebaseMaterializer = NonNullable<ExactSupportInput["rebaseMaterializer"]>;
type ExactRebaseInput = Parameters<ExactRebaseMaterializer["materialize"]>[0];

/** Stable App project context schema; its legacy identifier predates the sibling Guidance target. */
export const CODEX_APP_PROJECT_TARGET_CONTEXT_SCHEMA_ID = "CODEX_APP_PROJECT_SKILL_TARGET_V1";

interface ExactTargetSpec {
    assetKind: CodexExactAssetKind;
    nativeDialectId: string;
    agentRuntimeId: CodexExactRuntime;
    versionText: string;
    buildIdentity: `sha256:${string}`;
    platform: "wsl" | "win32";
    outputContractId: string;
    materializationProfileId: string;
    materializerCapabilityKey: string;
    targetContextSchemaId: string;
    fixtureId: string;
    parentRebaseFixtureId: string;
    targetRelativePath: PosixRelativePath;
    exactLoadMarker: string;
    reverseFixtureId: string;
}

export const CODEX_EXACT_TARGET_COMPONENTS = {
    Subagent: {
        path: component("codex.project-subagent-one-file-exact-path-v1"),
        reverse: component(`${CODEX_NATIVE_DIALECTS.subagent}.native-to-canonical-parser`),
        rebase: component("codex.project-subagent-one-file-parent-rebase-v1"),
    },
} as const;

const SUBAGENT_TARGET_RELATIVE_PATH = ".codex/agents/oaam-phase54-subagent.toml" as PosixRelativePath;
const SUBAGENT_EXACT_LOAD_MARKER = "OAAM_PHASE54_SUBAGENT_DEVELOPER_4F19B0";

const SUBAGENT_SPECS: Record<CodexExactRuntime, ExactTargetSpec> = {
    CODEX_CLI: {
        assetKind: "Subagent",
        nativeDialectId: CODEX_NATIVE_DIALECTS.subagent,
        agentRuntimeId: "CODEX_CLI",
        versionText: CODEX_CURRENT_BUILDS.CODEX_CLI.versionText,
        buildIdentity: CODEX_CURRENT_BUILDS.CODEX_CLI.buildIdentity,
        platform: CODEX_CURRENT_BUILDS.CODEX_CLI.platform,
        outputContractId: "CODEX_NATIVE_PROJECT_SUBAGENT_ONE_FILE_V1",
        materializationProfileId: "codex-cli-project-subagent-one-file-v1",
        materializerCapabilityKey: "codex.cli-project-subagent-exact-file-v1",
        targetContextSchemaId: "CODEX_CLI_PROJECT_GUIDANCE_TARGET_V1",
        fixtureId: "codex-cli-0.142.5-wsl-project-subagent-one-file-2026-08-02",
        parentRebaseFixtureId: "codex-cli-0.142.5-wsl-project-subagent-one-file-parent-rebase-v1",
        targetRelativePath: SUBAGENT_TARGET_RELATIVE_PATH,
        exactLoadMarker: SUBAGENT_EXACT_LOAD_MARKER,
        reverseFixtureId: "codex-cli-project-subagent-one-file-body-reverse-v1",
    },
    CODEX_APP: {
        assetKind: "Subagent",
        nativeDialectId: CODEX_NATIVE_DIALECTS.subagent,
        agentRuntimeId: "CODEX_APP",
        versionText: CODEX_CURRENT_BUILDS.CODEX_APP.versionText,
        buildIdentity: CODEX_CURRENT_BUILDS.CODEX_APP.buildIdentity,
        platform: CODEX_CURRENT_BUILDS.CODEX_APP.platform,
        outputContractId: "CODEX_APP_NATIVE_PROJECT_SUBAGENT_ONE_FILE_V1",
        materializationProfileId: "codex-app-project-subagent-one-file-v1",
        materializerCapabilityKey: "codex.app-project-subagent-exact-file-v1",
        targetContextSchemaId: CODEX_APP_PROJECT_TARGET_CONTEXT_SCHEMA_ID,
        fixtureId: `${CODEX_CURRENT_BUILDS.CODEX_APP.fixturePrefix}-project-subagent-one-file-2026-08-06`,
        parentRebaseFixtureId: `${CODEX_CURRENT_BUILDS.CODEX_APP.fixturePrefix}-project-subagent-one-file-parent-rebase-v1`,
        targetRelativePath: SUBAGENT_TARGET_RELATIVE_PATH,
        exactLoadMarker: SUBAGENT_EXACT_LOAD_MARKER,
        reverseFixtureId: "codex-app-project-subagent-one-file-body-reverse-v1",
    },
};

export function createCodexSubagentTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
}): Record<CodexExactRuntime, NativeProjectExactFileProviderSupport> {
    return {
        CODEX_CLI: createSupport(SUBAGENT_SPECS.CODEX_CLI, input),
        CODEX_APP: createSupport(SUBAGENT_SPECS.CODEX_APP, input),
    };
}

function createSupport(
    spec: ExactTargetSpec,
    input: { adapterVersion: string; agentRuntimes: readonly AgentRuntimeDescriptor[] },
): NativeProjectExactFileProviderSupport {
    const components = CODEX_EXACT_TARGET_COMPONENTS[spec.assetKind];
    const rebaseMaterializer: ExactRebaseMaterializer = {
        ref: components.rebase,
        materialize: (rebaseInput) => materializeParentNative(spec, rebaseInput),
    };
    const verifiedBuild = createVerifiedNativeProjectExactFileBuild({
        agentRuntimeId: spec.agentRuntimeId,
        versionText: spec.versionText,
        buildIdentity: spec.buildIdentity,
        platform: spec.platform,
        materializationProfileId: spec.materializationProfileId,
        fixtureId: spec.fixtureId,
        assetKind: spec.assetKind,
        nativeDialectId: spec.nativeDialectId,
        projectPathValidator: components.path,
        reverseParser: components.reverse,
        rebaseMaterializer: components.rebase,
        restorationDialectIds: [],
        parentRebaseFixtureId: spec.parentRebaseFixtureId,
        targetRelativePath: spec.targetRelativePath,
        exactLoadMarker: spec.exactLoadMarker,
        reverseFixtureId: spec.reverseFixtureId,
    });
    return createNativeProjectExactFileProviderSupport({
        adapterId: "CODEX",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: spec.assetKind,
        outputContractId: spec.outputContractId,
        materializationProfileId: spec.materializationProfileId,
        materializerCapabilityKey: spec.materializerCapabilityKey,
        nativeDialectId: spec.nativeDialectId,
        projectPathValidator: {
            ref: components.path,
            validate: (relativePath) => isExactProjectPath(spec.assetKind, relativePath),
        },
        reverseParser: {
            ref: components.reverse,
            parse: (parseInput) => {
                const canonicalEntryText = reverseCodexSubagentInstruction(
                    parseInput.appliedNativeText,
                    parseInput.currentNativeText,
                );
                return canonicalEntryText === null ? null : { canonicalEntryText };
            },
        },
        rebaseMaterializer,
        restorationDialectIds: [],
        target: { targetContextSchemaId: spec.targetContextSchemaId, requiredFacts: {} },
        buildCompatibility: codexTargetBuildCompatibilityFor(spec.agentRuntimeId),
        verifiedBuilds: [verifiedBuild],
    });
}

function materializeParentNative(spec: ExactTargetSpec, input: ExactRebaseInput): { nativeText: string } | null {
    return spec.assetKind === "Subagent" ? materializeParentSubagent(input) : null;
}

function materializeParentSubagent(input: ExactRebaseInput): { nativeText: string } | null {
    if (input.targetCanonical.kind !== "Subagent") return null;
    const entry = input.targetFiles[0];
    if (entry?.contentKind !== "text") return null;
    const target = projectCodexSubagentCanonical(input.targetCanonical, entry.text);
    if (target === null) return null;
    const nativeText = rebaseCodexSubagentToml(input.parent.file.text, target);
    if (nativeText === null) return null;
    const bytes = new TextEncoder().encode(nativeText);
    const { text: _parentText, ...parentDescriptor } = input.parent.file;
    const descriptor = {
        ...parentDescriptor,
        contentHash: sha256SourceBytes(bytes),
        byteSize: bytes.byteLength,
    };
    return validateCodexNativeDialect({
        canonical: input.targetCanonical,
        canonicalFiles: input.targetFiles,
        representation: { ...input.parent.representation, files: [descriptor] },
        nativeFiles: [{ relativePath: input.parent.file.relativePath, bytes }],
    })
        ? { nativeText }
        : null;
}

function isExactProjectPath(assetKind: CodexExactAssetKind, relativePath: PosixRelativePath): boolean {
    if (assetKind !== "Subagent" || !isCanonicalNativeRelativePath(relativePath)) return false;
    const segments = relativePath.split("/");
    return (
        segments.length === 3 &&
        segments[0] === ".codex" &&
        segments[1] === "agents" &&
        (segments[2]?.endsWith(".toml") ?? false) &&
        segments[2] !== ".toml"
    );
}
