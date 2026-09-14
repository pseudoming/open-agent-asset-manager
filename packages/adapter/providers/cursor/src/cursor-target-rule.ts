/** Cursor CLI/App project `.mdc` Rule target over the Core exact-native contract. */

import { adapterOperationDiagnostic, defineDialectComponentV1 as component } from "@oaam/adapter-framework";
import type {
    AdapterRenderAnalysisResult,
    AdapterRenderedTargetInspectionResult,
    AgentRuntimeDescriptor,
    NativeProjectExactFileProviderSupport,
    RenderAnalysisInput,
    RenderedTargetInspectionInput,
    RenderMaterializationResult,
} from "@oaam/core";
import { createNativeProjectExactFileProviderSupport, createVerifiedNativeProjectExactFileBuild } from "@oaam/core/adapter-spi";
import { parseCursorRule } from "./cursor-source-read-guidance-rule";
import { CURSOR_NATIVE_DIALECTS } from "./cursor-source-read-model";
import { isCursorRulePath, validateCursorNativeDialect } from "./cursor-source-read-native";
import { CURSOR_AGENT_TARGET_BUILD_COMPATIBILITY } from "./cursor-target-build-compatibility";

type ExactSupportInput = Parameters<typeof createNativeProjectExactFileProviderSupport>[0];
type ExactRebaseMaterializer = NonNullable<ExactSupportInput["rebaseMaterializer"]>;
type ExactRebaseInput = Parameters<ExactRebaseMaterializer["materialize"]>[0];
type ExactTextEntry = Extract<ExactRebaseInput["targetFiles"][number], { contentKind: "text" }>;

export const CURSOR_RULE_TARGET_COMPONENTS = {
    path: component("cursor.project-rule-mdc-exact-path-v1"),
    reverse: component(`${CURSOR_NATIVE_DIALECTS.rule}.native-to-canonical-parser`),
    rebase: component("cursor.project-rule-mdc-parent-rebase-v1"),
} as const;

interface CursorRuleRuntimeSpec {
    agentRuntimeId: "CURSOR_AGENT_CLI" | "CURSOR_APP";
    profileId: string;
    capabilityKey: string;
    outputContractId: string;
    targetRelativePath: `${string}.mdc`;
    loadMarker: string;
    builds: readonly {
        versionText: string;
        buildIdentity: `sha256:${string}`;
        platform: "linux" | "win32" | "wsl";
        fixturePrefix: string;
    }[];
}

const CLI_SPEC: CursorRuleRuntimeSpec = {
    agentRuntimeId: "CURSOR_AGENT_CLI",
    profileId: "cursor-agent-cli-project-rule-mdc-v1",
    capabilityKey: "cursor.agent-cli-project-rule-mdc-v1",
    outputContractId: "CURSOR_AGENT_CLI_NATIVE_PROJECT_RULE_MDC_V1",
    targetRelativePath: ".cursor/rules/oaam-phase58-rule.mdc",
    loadMarker: "OAAM_PHASE58_CURSOR_RULE_8B3D71",
    builds: [
        {
            versionText: "2026.07.23-e383d2b",
            buildIdentity: "sha256:eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831",
            platform: "wsl",
            fixturePrefix: "cursor-agent-cli-2026.07.23-wsl",
        },
    ],
};

const APP_SPEC: CursorRuleRuntimeSpec = {
    agentRuntimeId: "CURSOR_APP",
    profileId: "cursor-app-project-rule-mdc-v1",
    capabilityKey: "cursor.app-project-rule-mdc-v1",
    outputContractId: "CURSOR_APP_NATIVE_PROJECT_RULE_MDC_V1",
    targetRelativePath: ".cursor/rules/oaam-app-rule.mdc",
    loadMarker: "OAAM_CURSOR_APP_RULE_17C4",
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

export function createCursorRuleTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeProjectExactFileProviderSupport {
    return createRuleTargetSupport(CLI_SPEC, input);
}

export function createCursorAppRuleTargetSupport(
    input: Parameters<typeof createCursorRuleTargetSupport>[0],
): NativeProjectExactFileProviderSupport {
    return createRuleTargetSupport(APP_SPEC, input);
}

function createRuleTargetSupport(
    spec: CursorRuleRuntimeSpec,
    input: Parameters<typeof createCursorRuleTargetSupport>[0],
): NativeProjectExactFileProviderSupport {
    const rebaseMaterializer: ExactRebaseMaterializer = {
        ref: CURSOR_RULE_TARGET_COMPONENTS.rebase,
        materialize: materializeParentNative,
    };
    const verifiedBuilds = spec.builds.map((build) =>
        createVerifiedNativeProjectExactFileBuild({
            agentRuntimeId: spec.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: spec.profileId,
            fixtureId: `${build.fixturePrefix}-project-rule-mdc-2026-08-09`,
            assetKind: "Rule",
            nativeDialectId: CURSOR_NATIVE_DIALECTS.rule,
            projectPathValidator: CURSOR_RULE_TARGET_COMPONENTS.path,
            reverseParser: CURSOR_RULE_TARGET_COMPONENTS.reverse,
            rebaseMaterializer: CURSOR_RULE_TARGET_COMPONENTS.rebase,
            restorationDialectIds: [],
            parentRebaseFixtureId: `${build.fixturePrefix}-project-rule-mdc-parent-rebase-v1`,
            targetRelativePath: spec.targetRelativePath,
            exactLoadMarker: spec.loadMarker,
            reverseFixtureId: `${build.fixturePrefix}-project-rule-mdc-body-reverse-v1`,
        }),
    );
    const support = createNativeProjectExactFileProviderSupport({
        adapterId: "CURSOR",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: "Rule",
        outputContractId: spec.outputContractId,
        materializationProfileId: spec.profileId,
        materializerCapabilityKey: spec.capabilityKey,
        nativeDialectId: CURSOR_NATIVE_DIALECTS.rule,
        projectPathValidator: { ref: CURSOR_RULE_TARGET_COMPONENTS.path, validate: isCursorRulePath },
        reverseParser: {
            ref: CURSOR_RULE_TARGET_COMPONENTS.reverse,
            parse: (parseInput) => {
                const applied = splitNativeRule(parseInput.appliedNativeText, parseInput.relativePath);
                const current = splitNativeRule(parseInput.currentNativeText, parseInput.relativePath);
                return applied === null || current === null || applied.prefix !== current.prefix
                    ? null
                    : { canonicalEntryText: current.body };
            },
        },
        rebaseMaterializer,
        restorationDialectIds: [],
        target: {
            targetContextSchemaId: input.targetContextSchemaId,
            requiredFacts: { "oaam.project-binding": "registered" },
        },
        buildCompatibility: CURSOR_AGENT_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds,
    });
    return {
        ...support,
        analyze: (value) => (hasCursorRuleInput(value) ? support.analyze(value) : blockedAnalysis(value)),
        materialize: (value) => (hasCursorRuleInput(value) ? support.materialize(value) : blockedMaterialization()),
        inspect: (value) => (hasAppliedCursorRule(value) ? support.inspect(value) : blockedInspection()),
    };
}

function materializeParentNative(input: ExactRebaseInput): { nativeText: string } | null {
    const targetEntry = input.targetFiles[0] as ExactTextEntry;
    const parent = splitNativeRule(input.parent.file.text, input.parent.file.relativePath);
    if (parent === null || !parentBehaviorMatchesTarget(input, parent.body)) return null;
    return { nativeText: `${parent.prefix}${targetEntry.text}` };
}

function parentBehaviorMatchesTarget(input: ExactRebaseInput, parentBody: string): boolean {
    const entry = input.targetFiles[0] as ExactTextEntry;
    const { text: parentText, ...descriptor } = input.parent.file;
    return validateCursorNativeDialect({
        canonical: input.targetCanonical,
        canonicalFiles: [{ ...entry, text: parentBody }],
        representation: { ...input.parent.representation, files: [descriptor] },
        nativeFiles: [{ relativePath: input.parent.file.relativePath, bytes: new TextEncoder().encode(parentText) }],
    });
}

function splitNativeRule(nativeText: string, relativePath: string): { prefix: string; body: string } | null {
    const parsed = parseCursorRule(nativeText, relativePath);
    if (parsed.diagnostics.some((item) => item.severity === "error") || parsed.body.trim() === "") return null;
    return { prefix: nativeText.slice(0, nativeText.length - parsed.body.length), body: parsed.body };
}

function hasCursorRuleInput(input: Pick<RenderAnalysisInput, "dialectInputs">): boolean {
    return (
        input.dialectInputs.length > 0 &&
        input.dialectInputs.every((group) => {
            const representations = group.inputs.filter((candidate) => candidate.inputKind === "native_representation");
            const file = representations[0]?.files[0];
            return (
                representations.length === 1 &&
                representations[0]?.representation.dialectId === CURSOR_NATIVE_DIALECTS.rule &&
                representations[0].files.length === 1 &&
                file?.contentKind === "text" &&
                splitNativeRule(file.text, file.relativePath) !== null
            );
        })
    );
}

function hasAppliedCursorRule(input: RenderedTargetInspectionInput): boolean {
    return input.files.every(
        (file) =>
            file.fileState !== "added_managed_descendant" &&
            file.appliedContent.contentKind === "text" &&
            splitNativeRule(file.appliedContent.text, file.relativePath) !== null,
    );
}

function blockedAnalysis(input: RenderAnalysisInput): AdapterRenderAnalysisResult {
    const issue = shapeDiagnostic();
    return {
        status: "failed",
        outputUnits: [],
        semanticOptions: [],
        blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: "cursor_project_rule_native_parent_required",
            diagnostics: [issue],
        })),
        diagnostics: [issue],
    };
}

function blockedMaterialization(): RenderMaterializationResult {
    return {
        status: "failed",
        materializationState: "blocked",
        reasonCode: "cursor_project_rule_native_parent_required",
        diagnostics: [shapeDiagnostic()],
    };
}

function blockedInspection(): AdapterRenderedTargetInspectionResult {
    return { status: "failed", changes: [], files: [], diagnostics: [shapeDiagnostic()] };
}

function shapeDiagnostic() {
    return adapterOperationDiagnostic(
        "render",
        "cursor_project_rule_native_parent_required",
        "Cursor Rule deployment requires one validated current or immediate-parent `.mdc` native representation",
        "unsupported",
        "error",
    );
}
