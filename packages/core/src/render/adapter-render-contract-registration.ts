/** Registration-time compilation of provider-owned render declarations. */

import type { AdapterProviderStaticDeclarations, AdapterProviderSummary, AssetKind, OperationDiagnostic } from "../types";
import type {
    AdapterNativeExactGraphRenderDeclarationV1,
    AdapterNativeGraphRenderDeclarationV1,
    AdapterNativeProjectExactFileRenderDeclarationV1,
} from "../contracts/source-import";
import { stableStringify } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isCanonicalRelativePath, isSha256Digest } from "../foundation/validators";
import { createRenderRegistry, type RenderRegistryConfiguration } from "./render-registry";
import { nativeProjectGuidanceRegistryComponents } from "./native-project-guidance-behavior";
import { PLATFORM_FACT_KEY, makeNativeProjectGuidanceContractParts } from "./native-project-guidance-profiles";
import { nativeProjectRuleRegistryComponents } from "./native-project-rule-behavior";
import { isNativeProjectRuleFileNameSuffix, makeNativeProjectRuleContractParts } from "./native-project-rule-profiles";
import { nativeProjectExactFileRegistryComponents } from "./native-project-exact-file-behavior";
import { isNativeProjectExactFileAssetKind, makeNativeProjectExactFileContractParts } from "./native-project-exact-file-profiles";
import { nativeProjectExactGraphRegistryComponents } from "./native-project-exact-graph-behavior";
import {
    isNativeProjectExactGraphAssetKind,
    makeNativeProjectExactGraphContractParts,
} from "./native-project-exact-graph-profiles";
import { nativeProjectEncodedFileRegistryComponents } from "./native-project-encoded-file-behavior";
import { makeNativeProjectEncodedFileContractParts } from "./native-project-encoded-file-profiles";
import { isValidTargetBuildCompatibilityPolicy } from "./target-build-compatibility";
import {
    canonicalMaterializationValidatorsForProviders,
    type CanonicalMaterializationValidatorsByAdapter,
} from "./canonical-materialization-validation";

const PLATFORMS = new Set(["win32", "darwin", "linux", "wsl"]);

/**
 * Compile the complete staged provider set before it becomes visible. This is
 * deliberately stronger than shape validation: declaration-derived contracts,
 * target capabilities, materializers, schemas and exact-build conformances must
 * all agree in one registry or registration fails closed.
 */
export function validateAdapterRenderContractRegistration(
    providers: readonly AdapterProviderStaticDeclarations[],
): OperationDiagnostic[] {
    const summaries = providers.map(toSummary);
    try {
        for (const provider of providers) validateProviderDeclarations(provider, providers);
        createRenderRegistry({
            providers: summaries,
            ...adapterRenderRegistryComponents(summaries, canonicalMaterializationValidatorsForProviders(providers)),
        });
        return [];
    } catch (error) {
        return [
            {
                severity: "error",
                code: "adapter.render_contract_invalid",
                message: `provider render contract is invalid: ${String(error)}`,
                path: "",
                traceId: "",
                operation: "internal",
                causeKind: "invalid_schema",
                retryable: false,
                suggestedActions: [],
                rawSummary: "",
            },
        ];
    }
}

export function adapterRenderRegistryComponents(
    providers: readonly AdapterProviderSummary[],
    canonicalValidators: CanonicalMaterializationValidatorsByAdapter = new Map(),
): Pick<
    RenderRegistryConfiguration,
    | "canonicalMaterializationValidators"
    | "outputContracts"
    | "consumerConformances"
    | "targetApplicabilityPredicates"
    | "materializationValidators"
    | "reverseInspectionValidators"
> {
    const guidance = nativeProjectGuidanceRegistryComponents(providers);
    const rule = nativeProjectRuleRegistryComponents(providers);
    const exactFile = nativeProjectExactFileRegistryComponents(providers);
    const exactGraph = nativeProjectExactGraphRegistryComponents(providers, canonicalValidators);
    const encodedFile = nativeProjectEncodedFileRegistryComponents(providers);
    return {
        canonicalMaterializationValidators: exactGraph.canonicalMaterializationValidators,
        outputContracts: [
            ...guidance.outputContracts,
            ...rule.outputContracts,
            ...exactFile.outputContracts,
            ...exactGraph.outputContracts,
            ...encodedFile.outputContracts,
        ],
        consumerConformances: [
            ...guidance.consumerConformances,
            ...rule.consumerConformances,
            ...exactFile.consumerConformances,
            ...exactGraph.consumerConformances,
            ...encodedFile.consumerConformances,
        ],
        targetApplicabilityPredicates: [
            ...guidance.targetApplicabilityPredicates,
            ...rule.targetApplicabilityPredicates,
            ...exactFile.targetApplicabilityPredicates,
            ...exactGraph.targetApplicabilityPredicates,
            ...encodedFile.targetApplicabilityPredicates,
        ],
        materializationValidators: [
            ...guidance.materializationValidators,
            ...rule.materializationValidators,
            ...exactFile.materializationValidators,
            ...exactGraph.materializationValidators,
            ...encodedFile.materializationValidators,
        ],
        reverseInspectionValidators: [
            ...guidance.reverseInspectionValidators,
            ...rule.reverseInspectionValidators,
            ...exactFile.reverseInspectionValidators,
            ...exactGraph.reverseInspectionValidators,
            ...encodedFile.reverseInspectionValidators,
        ],
    };
}

function validateProviderDeclarations(
    provider: AdapterProviderStaticDeclarations,
    providers: readonly AdapterProviderStaticDeclarations[],
): void {
    const declarationKeys = new Set<string>();
    const validatedDeclarations: Array<{
        declaration: (typeof provider.renderContractDeclarations)[number];
        schema: (typeof provider.targetContextSchemas)[number];
        outputContract: ReturnType<typeof makeNativeProjectGuidanceContractParts>["outputContract"];
        assetKind: AssetKind;
    }> = [];
    for (const declaration of provider.renderContractDeclarations) {
        if (
            "canonicalMaterialization" in declaration &&
            (declaration.canonicalMaterialization?.assessesLoss !== undefined ||
                "requiresNativeSourceAssessment" in (declaration.canonicalMaterialization ?? {})) &&
            declaration.declarationKind !== "native_project_exact_graph_v1" &&
            declaration.declarationKind !== "native_global_exact_graph_v1"
        ) {
            throw new Error("canonical loss assessment requires an exact-graph declaration");
        }
        if (
            declaration.schemaVersion !== 1 ||
            (declaration.declarationKind !== "native_project_guidance_v1" &&
                declaration.declarationKind !== "native_global_guidance_v1" &&
                declaration.declarationKind !== "native_project_rule_v1" &&
                declaration.declarationKind !== "native_global_rule_v1" &&
                declaration.declarationKind !== "native_project_exact_file_v1" &&
                declaration.declarationKind !== "native_project_encoded_file_v1" &&
                declaration.declarationKind !== "native_global_encoded_file_v1" &&
                declaration.declarationKind !== "native_project_exact_graph_v1" &&
                declaration.declarationKind !== "native_global_exact_graph_v1")
        ) {
            throw new Error("provider render declaration kind/version is unsupported");
        }
        const declarationKey = [
            declaration.declarationKind,
            declaration.agentRuntimeId,
            declaration.declarationKind === "native_project_exact_file_v1" || isGraphLifecycleDeclaration(declaration)
                ? declaration.assetKind
                : "",
            declaration.outputContractId,
        ].join("\0");
        if (declarationKeys.has(declarationKey)) {
            throw new Error("provider has duplicate native render declarations");
        }
        declarationKeys.add(declarationKey);
        const targetPathIsValid =
            declaration.declarationKind === "native_project_guidance_v1" ||
            declaration.declarationKind === "native_global_guidance_v1"
                ? isCanonicalRelativePath(declaration.target.relativePath)
                : declaration.declarationKind === "native_project_rule_v1" ||
                    declaration.declarationKind === "native_global_rule_v1"
                  ? isCanonicalRelativePath(declaration.target.relativeDirectory) &&
                    isNativeProjectRuleFileNameSuffix(declaration.target.fileNameSuffix)
                  : declaration.declarationKind === "native_project_exact_file_v1"
                    ? isNativeProjectExactFileAssetKind(declaration.assetKind) && isCanonicalText(declaration.nativeDialectId)
                    : declaration.declarationKind === "native_project_encoded_file_v1" ||
                        declaration.declarationKind === "native_global_encoded_file_v1"
                      ? declaration.assetKind === "Subagent" && isCanonicalText(declaration.nativeDialectId)
                      : isNativeProjectExactGraphAssetKind(declaration.assetKind) && isCanonicalText(declaration.nativeDialectId);
        if (
            !isCanonicalText(declaration.outputContractId) ||
            !isCanonicalText(declaration.materializationProfileId) ||
            !isCanonicalText(declaration.agentRuntimeId) ||
            !targetPathIsValid ||
            !isCanonicalText(declaration.target.targetContextSchemaId)
        ) {
            throw new Error("native render declaration identity/path is invalid");
        }
        const descriptors = provider.agentRuntimes.filter(
            (descriptor) => descriptor.agentRuntimeId === declaration.agentRuntimeId,
        );
        if (descriptors.length !== 1) {
            throw new Error("native render declaration has no unique provider descriptor");
        }
        const schemas = provider.targetContextSchemas.filter(
            (schema) =>
                schema.agentRuntimeId === declaration.agentRuntimeId &&
                schema.targetContextSchemaId === declaration.target.targetContextSchemaId,
        );
        const schema = schemas[0];
        if (schemas.length !== 1 || schema === undefined) {
            throw new Error("native render declaration has no unique provider schema");
        }
        const requiredFacts = Object.entries(declaration.target.requiredFacts);
        if (
            requiredFacts.some(([key, value]) => !isCanonicalText(key) || !isCanonicalText(value)) ||
            Object.hasOwn(declaration.target.requiredFacts, PLATFORM_FACT_KEY) ||
            !sameTextSet(
                [PLATFORM_FACT_KEY, ...requiredFacts.map(([key]) => key)],
                schema.factRules.map((rule) => rule.key),
            )
        ) {
            throw new Error("native render declaration facts do not match its provider schema");
        }
        if (declaration.verifiedBuilds.length === 0) {
            throw new Error("native render declaration requires exact verified builds");
        }
        if (
            "buildCompatibility" in declaration &&
            declaration.buildCompatibility !== undefined &&
            !isValidTargetBuildCompatibilityPolicy(declaration.buildCompatibility)
        ) {
            throw new Error("native render declaration has an invalid target build compatibility policy");
        }
        const buildKeys = new Set<string>();
        for (const build of declaration.verifiedBuilds) {
            if (
                build.agentRuntimeId !== declaration.agentRuntimeId ||
                build.materializationProfileId !== declaration.materializationProfileId ||
                !isCanonicalText(build.versionText) ||
                !isSha256Digest(build.buildIdentity) ||
                !isSha256Digest(build.fixtureSetFingerprint) ||
                !PLATFORMS.has(build.platform)
            ) {
                throw new Error("native render verified build does not belong to its declaration");
            }
            const buildKey = [
                build.agentRuntimeId,
                build.versionText,
                build.buildIdentity,
                build.platform,
                build.materializationProfileId,
                build.fixtureSetFingerprint,
            ].join("\0");
            if (buildKeys.has(buildKey)) {
                throw new Error("native render declaration has a duplicate verified build");
            }
            buildKeys.add(buildKey);
        }

        const resolvedAssetKind: AssetKind =
            declaration.declarationKind === "native_project_guidance_v1" ||
            declaration.declarationKind === "native_global_guidance_v1"
                ? "Guidance"
                : declaration.declarationKind === "native_project_rule_v1" ||
                    declaration.declarationKind === "native_global_rule_v1"
                  ? "Rule"
                  : declaration.assetKind;
        const { outputContract } =
            declaration.declarationKind === "native_project_guidance_v1" ||
            declaration.declarationKind === "native_global_guidance_v1"
                ? makeNativeProjectGuidanceContractParts(declaration)
                : declaration.declarationKind === "native_project_rule_v1" ||
                    declaration.declarationKind === "native_global_rule_v1"
                  ? makeNativeProjectRuleContractParts(declaration)
                  : declaration.declarationKind === "native_project_exact_file_v1"
                    ? makeNativeProjectExactFileContractParts(declaration)
                    : declaration.declarationKind === "native_project_encoded_file_v1" ||
                        declaration.declarationKind === "native_global_encoded_file_v1"
                      ? makeNativeProjectEncodedFileContractParts(declaration)
                      : makeNativeProjectExactGraphContractParts(declaration);
        if (declaration.declarationKind === "native_project_exact_file_v1") {
            validateExactFileDialectDeclaration(provider, declaration);
        } else if (isGraphLifecycleDeclaration(declaration)) {
            validateGraphLifecycleDialectDeclaration(provider, declaration);
        }
        const targetCapabilities = provider.assetTargetCapabilities.filter(
            (capability) =>
                capability.entrySupportStatus === "supported" &&
                capability.agentRuntimeId === declaration.agentRuntimeId &&
                capability.assetKind === resolvedAssetKind &&
                capability.renderStrategy === (isGraphLifecycleDeclaration(declaration) ? "native_graph" : "native_file") &&
                capability.outputContractId === outputContract.outputContractId &&
                capability.outputContractFingerprint === outputContract.outputContractFingerprint &&
                capability.targetContextSchemaId === declaration.target.targetContextSchemaId &&
                capability.targetContextSchemaFingerprint === schema.schemaFingerprint &&
                capability.reverseExtractPolicy === "can_reconcile",
        );
        if (targetCapabilities.length !== 1) {
            throw new Error("native render declaration has no exact target capability");
        }
        const materializers = providers.flatMap((candidate) =>
            candidate.materializerCapabilities.filter(
                (capability) =>
                    capability.outputContractId === outputContract.outputContractId &&
                    capability.outputContractFingerprint === outputContract.outputContractFingerprint &&
                    capability.materializationProfileIds.includes(declaration.materializationProfileId),
            ),
        );
        if (materializers.length === 0) {
            throw new Error("native render declaration has no exact materializer capability");
        }
        validatedDeclarations.push({ declaration, schema, outputContract, assetKind: resolvedAssetKind });
    }

    for (const capability of provider.assetTargetCapabilities) {
        if (capability.entrySupportStatus !== "supported" || !("renderStrategy" in capability)) {
            continue;
        }
        const declarations = validatedDeclarations.filter(
            ({ declaration, schema, outputContract, assetKind }) =>
                declaration.agentRuntimeId === capability.agentRuntimeId &&
                capability.assetKind === assetKind &&
                capability.renderStrategy === (isGraphLifecycleDeclaration(declaration) ? "native_graph" : "native_file") &&
                capability.outputContractId === outputContract.outputContractId &&
                capability.outputContractFingerprint === outputContract.outputContractFingerprint &&
                capability.targetContextSchemaId === declaration.target.targetContextSchemaId &&
                capability.targetContextSchemaFingerprint === schema.schemaFingerprint &&
                capability.reverseExtractPolicy === "can_reconcile",
        );
        if (declarations.length !== 1) {
            throw new Error("supported target capability has no unique provider declaration");
        }
    }
}

function validateGraphLifecycleDialectDeclaration(
    provider: AdapterProviderStaticDeclarations,
    declaration: AdapterNativeGraphRenderDeclarationV1,
): void {
    const dialects = provider.dialectContracts.native.filter(
        (contract) =>
            contract.definition.kind === declaration.assetKind && contract.definition.dialectId === declaration.nativeDialectId,
    );
    const dialect = dialects[0];
    if (dialects.length !== 1 || dialect === undefined) {
        throw new Error("native exact-graph declaration has no unique provider dialect contract");
    }
    if (stableStringify(dialect.definition.nativeToCanonicalParser) !== stableStringify(declaration.reverseParser)) {
        throw new Error("native exact-graph declaration does not match its provider dialect parser");
    }
    if (stableStringify(dialect.definition.rebaseMaterializer) !== stableStringify(declaration.rebaseMaterializer)) {
        throw new Error("native exact-graph declaration does not match its provider dialect rebase materializer");
    }
    for (const dialectId of declaration.restorationDialectIds) {
        const restorations = provider.dialectContracts.restoration.filter(
            (contract) => contract.definition.kind === declaration.assetKind && contract.definition.dialectId === dialectId,
        );
        if (restorations.length !== 1) {
            throw new Error("native exact-graph declaration has no unique provider restoration dialect contract");
        }
    }
}

function isExactGraphDeclaration(
    declaration: AdapterProviderStaticDeclarations["renderContractDeclarations"][number],
): declaration is AdapterNativeExactGraphRenderDeclarationV1 {
    return (
        declaration.declarationKind === "native_project_exact_graph_v1" ||
        declaration.declarationKind === "native_global_exact_graph_v1"
    );
}

function isGraphLifecycleDeclaration(
    declaration: AdapterProviderStaticDeclarations["renderContractDeclarations"][number],
): declaration is AdapterNativeGraphRenderDeclarationV1 {
    return (
        declaration.declarationKind === "native_project_encoded_file_v1" ||
        declaration.declarationKind === "native_global_encoded_file_v1" ||
        isExactGraphDeclaration(declaration)
    );
}

function validateExactFileDialectDeclaration(
    provider: AdapterProviderStaticDeclarations,
    declaration: AdapterNativeProjectExactFileRenderDeclarationV1,
): void {
    const dialects = provider.dialectContracts.native.filter(
        (contract) =>
            contract.definition.kind === declaration.assetKind && contract.definition.dialectId === declaration.nativeDialectId,
    );
    const dialect = dialects[0];
    if (dialects.length !== 1 || dialect === undefined) {
        throw new Error("native exact-file declaration has no unique provider dialect contract");
    }
    if (stableStringify(dialect.definition.nativeToCanonicalParser) !== stableStringify(declaration.reverseParser)) {
        throw new Error("native exact-file declaration does not match its provider dialect parser");
    }
    if (stableStringify(dialect.definition.rebaseMaterializer) !== stableStringify(declaration.rebaseMaterializer)) {
        throw new Error("native exact-file declaration does not match its provider dialect rebase materializer");
    }
    for (const dialectId of declaration.restorationDialectIds) {
        const restorations = provider.dialectContracts.restoration.filter(
            (contract) => contract.definition.kind === declaration.assetKind && contract.definition.dialectId === dialectId,
        );
        if (restorations.length !== 1) {
            throw new Error("native exact-file declaration has no unique provider restoration dialect contract");
        }
    }
}

function isCanonicalText(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes("\0");
}

function sameTextSet(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    const sortedLeft = [...left].sort(compareUtf8Bytes);
    const sortedRight = [...right].sort(compareUtf8Bytes);
    return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function toSummary(provider: AdapterProviderStaticDeclarations): AdapterProviderSummary {
    return {
        adapterId: provider.adapterId,
        displayName: provider.displayName,
        version: provider.version,
        enabled: true,
        agentRuntimes: provider.agentRuntimes,
        targetContextSchemas: provider.targetContextSchemas,
        assetSourceCapabilities: provider.assetSourceCapabilities,
        assetTargetCapabilities: provider.assetTargetCapabilities,
        materializerCapabilities: provider.materializerCapabilities,
        renderContractDeclarations: provider.renderContractDeclarations,
    };
}
