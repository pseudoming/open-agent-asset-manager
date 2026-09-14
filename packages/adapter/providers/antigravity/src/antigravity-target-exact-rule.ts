/** Antigravity exact-build always-on project Rules over the Core exact-native contract. */

import { adapterOperationDiagnostic, defineDialectComponentV1 as component } from "@oaam/adapter-framework";
import type {
    AdapterRenderAnalysisResult,
    AdapterRenderedTargetInspectionResult,
    AgentRuntimeDescriptor,
    NativeProjectExactFileProviderSupport,
    PosixRelativePath,
    RenderAnalysisInput,
    RenderedTargetInspectionInput,
    RenderMaterializationResult,
} from "@oaam/core";
import { createNativeProjectExactFileProviderSupport, createVerifiedNativeProjectExactFileBuild } from "@oaam/core/adapter-spi";
import { antigravityFrontmatterString, parseAntigravityFrontmatter } from "./antigravity-frontmatter";
import { ANTIGRAVITY_NATIVE_DIALECTS, validateAntigravityNativeDialect } from "./antigravity-source-read";
import {
    ANTIGRAVITY_APP_TARGET_BUILD_COMPATIBILITY,
    ANTIGRAVITY_CLI_TARGET_BUILD_COMPATIBILITY,
    ANTIGRAVITY_IDE_TARGET_BUILD_COMPATIBILITY,
} from "./antigravity-target-build-compatibility";

type ExactSupportInput = Parameters<typeof createNativeProjectExactFileProviderSupport>[0];
type ExactRebaseMaterializer = NonNullable<ExactSupportInput["rebaseMaterializer"]>;
type ExactRebaseInput = Parameters<ExactRebaseMaterializer["materialize"]>[0];
type ExactTextEntry = Extract<ExactRebaseInput["targetFiles"][number], { contentKind: "text" }>;

export const ANTIGRAVITY_RULE_TARGET_COMPONENTS = {
    path: component("antigravity.project-rule-always-exact-path-v1"),
    reverse: component(`${ANTIGRAVITY_NATIVE_DIALECTS.rule}.native-to-canonical-parser`),
    rebase: component("antigravity.project-rule-always-parent-rebase-v1"),
} as const;

const CLI_RULE_SPEC = {
    agentRuntimeId: "ANTIGRAVITY_CLI",
    runtimeLabel: "Antigravity CLI",
    outputContractId: "ANTIGRAVITY_NATIVE_PROJECT_RULE_ALWAYS_V1",
    materializationProfileId: "antigravity-cli-project-rule-always-v1",
    materializerCapabilityKey: "antigravity.cli-project-rule-exact-file-v1",
    exactLoadMarker: "OAAM_AGY_RULE_112_8C4E91",
    buildCompatibility: ANTIGRAVITY_CLI_TARGET_BUILD_COMPATIBILITY,
    verifiedBuilds: [
        {
            versionText: "1.1.2",
            buildIdentity: "sha256:70bf6eaf2e82fbb243db999b9c7c61fcf7f6e537f41980650eb2341ed84b24de",
            platform: "wsl",
            fixtureId: "antigravity-cli-1.1.2-wsl-project-rule-always-2026-08-02",
        },
    ],
} as const;

const IDE_RULE_SPEC = {
    agentRuntimeId: "ANTIGRAVITY_IDE",
    runtimeLabel: "Antigravity IDE",
    outputContractId: "ANTIGRAVITY_IDE_NATIVE_PROJECT_RULE_ALWAYS_V1",
    materializationProfileId: "antigravity-ide-project-rule-always-v1",
    materializerCapabilityKey: "antigravity.ide-project-rule-exact-file-v1",
    exactLoadMarker: "OAAM_PHASE55_IDE_PROJECT_RULE",
    buildCompatibility: ANTIGRAVITY_IDE_TARGET_BUILD_COMPATIBILITY,
    verifiedBuilds: [
        {
            versionText: "1.107.0",
            buildIdentity: "sha256:56987be1a655ae5903bc47963a67e147d8ee3c36e41144b03210cc9c3e57336f",
            platform: "wsl",
            fixtureId: "antigravity-ide-2.1.1-wsl-project-rule-always-2026-08-07",
        },
        {
            versionText: "1.107.0",
            buildIdentity: "sha256:dca2f8dc41186aff715298830fa3a10cb310e632cb51bb76dac30c2c2fbe37a2",
            platform: "win32",
            fixtureId: "antigravity-ide-2.1.1-win32-project-rule-always-2026-08-07",
        },
    ],
} as const;

const APP_RULE_SPEC = {
    agentRuntimeId: "ANTIGRAVITY_APP",
    runtimeLabel: "Antigravity App",
    outputContractId: "ANTIGRAVITY_APP_NATIVE_PROJECT_RULE_ALWAYS_V1",
    materializationProfileId: "antigravity-app-project-rule-always-v1",
    materializerCapabilityKey: "antigravity.app-project-rule-exact-file-v1",
    exactLoadMarker: "OAAM_PHASE55_APP_PROJECT_RULE",
    buildCompatibility: ANTIGRAVITY_APP_TARGET_BUILD_COMPATIBILITY,
    verifiedBuilds: [
        {
            versionText: "2.2.1",
            buildIdentity: "sha256:b0d127772d2983a93771055a93b673d5fdd1726d6e47db8e269b204e665972d6",
            platform: "wsl",
            fixtureId: "antigravity-app-2.2.1-wsl-project-rule-always-2026-08-07",
        },
        {
            versionText: "2.4.3",
            buildIdentity: "sha256:4dbd1be0a6ebe48ebd370babf9b7d046630b8eac7bb69fbb0469db1aea12bcf8",
            platform: "win32",
            fixtureId: "antigravity-app-2.4.3-win32-project-rule-always-2026-08-07",
        },
    ],
} as const;

type RuleRuntimeSpec = typeof CLI_RULE_SPEC | typeof IDE_RULE_SPEC | typeof APP_RULE_SPEC;

export function createAntigravityRuleTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeProjectExactFileProviderSupport {
    return createRuleTargetSupport(CLI_RULE_SPEC, input);
}

export function createAntigravityIdeRuleTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeProjectExactFileProviderSupport {
    return createRuleTargetSupport(IDE_RULE_SPEC, input);
}

export function createAntigravityAppRuleTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeProjectExactFileProviderSupport {
    return createRuleTargetSupport(APP_RULE_SPEC, input);
}

function createRuleTargetSupport(
    spec: RuleRuntimeSpec,
    input: {
        adapterVersion: string;
        agentRuntimes: readonly AgentRuntimeDescriptor[];
        targetContextSchemaId: string;
    },
): NativeProjectExactFileProviderSupport {
    const rebaseMaterializer: ExactRebaseMaterializer = {
        ref: ANTIGRAVITY_RULE_TARGET_COMPONENTS.rebase,
        materialize: materializeParentNative,
    };
    const verifiedBuilds = spec.verifiedBuilds.map((build) =>
        createVerifiedNativeProjectExactFileBuild({
            agentRuntimeId: spec.agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            platform: build.platform,
            materializationProfileId: spec.materializationProfileId,
            fixtureId: build.fixtureId,
            assetKind: "Rule",
            nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.rule,
            projectPathValidator: ANTIGRAVITY_RULE_TARGET_COMPONENTS.path,
            reverseParser: ANTIGRAVITY_RULE_TARGET_COMPONENTS.reverse,
            rebaseMaterializer: ANTIGRAVITY_RULE_TARGET_COMPONENTS.rebase,
            restorationDialectIds: [],
            parentRebaseFixtureId: `${build.fixtureId}-parent-rebase-v1`,
            targetRelativePath: ".agents/rules/oaam-phase55-rule.md",
            exactLoadMarker: spec.exactLoadMarker,
            reverseFixtureId: `${build.fixtureId}-body-reverse-v1`,
        }),
    );
    const exactFile = createNativeProjectExactFileProviderSupport({
        adapterId: "ANTIGRAVITY",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: "Rule",
        outputContractId: spec.outputContractId,
        materializationProfileId: spec.materializationProfileId,
        materializerCapabilityKey: spec.materializerCapabilityKey,
        nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.rule,
        projectPathValidator: {
            ref: ANTIGRAVITY_RULE_TARGET_COMPONENTS.path,
            validate: isExactRulePath,
        },
        reverseParser: {
            ref: ANTIGRAVITY_RULE_TARGET_COMPONENTS.reverse,
            parse: (parseInput) => {
                const applied = splitNativeRule(parseInput.appliedNativeText);
                const current = splitNativeRule(parseInput.currentNativeText);
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
        buildCompatibility: spec.buildCompatibility,
        verifiedBuilds,
    });
    return {
        ...exactFile,
        analyze: (value) =>
            hasVerifiedAlwaysOnRuleInput(value) ? exactFile.analyze(value) : blockedRuleAnalysis(value, spec.runtimeLabel),
        materialize: (value) =>
            hasVerifiedAlwaysOnRuleInput(value) ? exactFile.materialize(value) : blockedRuleMaterialization(spec.runtimeLabel),
        inspect: (value) =>
            hasVerifiedAppliedAlwaysOnRule(value) ? exactFile.inspect(value) : blockedRuleInspection(spec.runtimeLabel),
    };
}

function materializeParentNative(input: ExactRebaseInput): { nativeText: string } | null {
    const entry = input.targetFiles[0] as ExactTextEntry;
    const parent = splitNativeRule(input.parent.file.text);
    if (parent === null || !parentBehaviorMatchesTarget(input, parent.body)) return null;
    return { nativeText: `${parent.prefix}${entry.text}` };
}

function parentBehaviorMatchesTarget(input: ExactRebaseInput, parentBody: string): boolean {
    const entry = input.targetFiles[0] as ExactTextEntry;
    const { text: parentText, ...descriptor } = input.parent.file;
    return validateAntigravityNativeDialect({
        canonical: input.targetCanonical,
        canonicalFiles: [{ ...entry, text: parentBody }],
        representation: { ...input.parent.representation, files: [descriptor] },
        nativeFiles: [
            {
                relativePath: input.parent.file.relativePath,
                bytes: new TextEncoder().encode(parentText),
            },
        ],
    });
}

function splitNativeRule(nativeText: string): { prefix: string; body: string } | null {
    const parsed = parseAntigravityFrontmatter(nativeText);
    if (
        !parsed.hasFrontmatter ||
        !parsed.closed ||
        parsed.diagnostics.length !== 0 ||
        parsed.body.trim() === "" ||
        parsed.presentKeys.length !== 1 ||
        parsed.presentKeys[0] !== "trigger" ||
        antigravityFrontmatterString(parsed, "trigger") !== "always_on"
    ) {
        return null;
    }
    return {
        prefix: nativeText.slice(0, nativeText.length - parsed.body.length),
        body: parsed.body,
    };
}

function hasVerifiedAlwaysOnRuleInput(input: Pick<RenderAnalysisInput, "dialectInputs">): boolean {
    return (
        input.dialectInputs.length > 0 &&
        input.dialectInputs.every((group) => {
            const nativeInputs = group.inputs.filter((candidate) => candidate.inputKind === "native_representation");
            const file = nativeInputs[0]?.files[0];
            return (
                nativeInputs.length === 1 &&
                nativeInputs[0]?.files.length === 1 &&
                file?.contentKind === "text" &&
                splitNativeRule(file.text) !== null
            );
        })
    );
}

function hasVerifiedAppliedAlwaysOnRule(input: RenderedTargetInspectionInput): boolean {
    return input.files.every(
        (file) =>
            file.fileState !== "added_managed_descendant" &&
            file.appliedContent.contentKind === "text" &&
            splitNativeRule(file.appliedContent.text) !== null,
    );
}

function blockedRuleAnalysis(input: RenderAnalysisInput, runtimeLabel: string): AdapterRenderAnalysisResult {
    const issue = ruleShapeDiagnostic(runtimeLabel);
    return {
        status: "failed",
        outputUnits: [],
        semanticOptions: [],
        blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: "antigravity_project_rule_exact_file_not_applicable",
            diagnostics: [issue],
        })),
        diagnostics: [issue],
    };
}

function blockedRuleMaterialization(runtimeLabel: string): RenderMaterializationResult {
    return {
        status: "failed",
        materializationState: "blocked",
        reasonCode: "antigravity_project_rule_exact_file_materialization_invalid",
        diagnostics: [ruleShapeDiagnostic(runtimeLabel)],
    };
}

function blockedRuleInspection(runtimeLabel: string): AdapterRenderedTargetInspectionResult {
    return { status: "failed", changes: [], files: [], diagnostics: [ruleShapeDiagnostic(runtimeLabel)] };
}

function ruleShapeDiagnostic(runtimeLabel: string) {
    return adapterOperationDiagnostic(
        "render",
        "antigravity_project_rule_exact_file_blocked",
        `${runtimeLabel} target accepts only the verified trigger: always_on workspace Rule shape`,
        "unsupported",
        "error",
    );
}

function isExactRulePath(relativePath: PosixRelativePath): boolean {
    if (relativePath.includes("\0") || relativePath.includes("\\")) return false;
    const segments = relativePath.split("/");
    return (
        segments.length >= 3 &&
        segments[0] === ".agents" &&
        segments[1] === "rules" &&
        segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
        (segments.at(-1)?.endsWith(".md") ?? false) &&
        segments.at(-1) !== ".md"
    );
}
