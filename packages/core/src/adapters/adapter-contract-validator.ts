/**
 * Final adapter registration and probe-result validators.
 *
 * Static declarations are provider facts. Dynamic observations are current
 * machine facts. This module validates each authority independently and never
 * infers installation from residual data or static capability rows.
 */

import type {
    AdapterAssetTargetCapability,
    AdapterProviderStaticDeclarations,
    AdapterTargetContextSchemaDeclaration,
    AgentRuntimeDescriptor,
    AgentRuntimeId,
    AssetKind,
    OperationDiagnostic,
    Sha256Digest,
} from "../types";
import { fingerprintDomain, stableStringify } from "../foundation/fingerprint";
import { BUILTIN_ASSET_KINDS } from "../specs/registry";
import { isSha256Digest } from "../foundation/validators";
import { assertAdapterDialectContracts } from "../catalog/version-dialect-registry";
import { computeSourceCapabilityFingerprint, sourceCapabilityPreimage } from "./adapter-source-capability";
import {
    ROOT_LOCATOR_KINDS,
    ROOT_ROLES,
    SOURCE_DOMAINS,
    SOURCE_EVIDENCE_LEVELS,
    compareCodeUnitText,
    issue,
    requireAllowed,
    requireNonBlank,
} from "./adapter-validation-helpers";

const TARGET_CONTEXT_SCHEMA_DOMAIN = "oaam.render.target-context-schema.v1";
const ASSET_KINDS = new Set<string>(BUILTIN_ASSET_KINDS);
const ENTRY_CLASSES = new Set(["cli", "app", "ide"]);
const ENTRY_SUPPORT_STATUSES = new Set(["supported", "unsupported", "docs_declared_unverified", "deferred"]);
const SOURCE_PATH_MECHANISMS = new Set(["fixed_file", "directory_entry", "recursive_entry", "manifest_declared", "unknown"]);
const READ_POLICIES = new Set(["auto_read", "user_selected_root_only", "report_only"]);
const RENDER_STRATEGIES = new Set([
    "native_file",
    "native_directory",
    "native_graph",
    "native_import",
    "inline",
    "reference_with_intro",
]);
const REVERSE_EXTRACT_POLICIES = new Set(["can_reconcile", "ignore_generated_wrapper", "requires_user_choice", "unsupported"]);

export { computeSourceCapabilityFingerprint } from "./adapter-source-capability";

export function computeTargetContextSchemaFingerprint(
    provider: Pick<AdapterProviderStaticDeclarations, "adapterId" | "agentRuntimes">,
    schema: AdapterTargetContextSchemaDeclaration,
): Sha256Digest | null {
    const descriptor = provider.agentRuntimes.find((candidate) => candidate.agentRuntimeId === schema.agentRuntimeId);
    if (descriptor === undefined) return null;
    return fingerprintDomain(TARGET_CONTEXT_SCHEMA_DOMAIN, {
        adapterId: provider.adapterId,
        targetContextSchemaId: schema.targetContextSchemaId,
        agentRuntimeId: schema.agentRuntimeId,
        entryClass: descriptor.entryClass,
        factRules: [...schema.factRules]
            .sort((left, right) => compareCodeUnitText(left.key, right.key))
            .map((rule) => ({
                key: rule.key,
                valueKind: rule.valueKind,
                normalization: rule.normalization,
            })),
    });
}

export function validateAdapterProviderRegistration(
    provider: AdapterProviderStaticDeclarations,
    registeredProviders: readonly AdapterProviderStaticDeclarations[],
): OperationDiagnostic[] {
    return validateStaticRegistration(provider, registeredProviders, true);
}

/** Retained inspection owns no source-read capability; all target and dialect checks still apply. */
export function validateRetainedInspectionRegistration(provider: AdapterProviderStaticDeclarations): OperationDiagnostic[] {
    return validateStaticRegistration(provider, [], false);
}

function validateStaticRegistration(
    provider: AdapterProviderStaticDeclarations,
    registeredProviders: readonly AdapterProviderStaticDeclarations[],
    includeSourceRead: boolean,
): OperationDiagnostic[] {
    const issues: OperationDiagnostic[] = [];
    requireNonBlank(provider.adapterId, "adapterId", issues);
    requireNonBlank(provider.displayName, "displayName", issues);
    requireNonBlank(provider.version, "version", issues);

    const descriptorIds = new Set<AgentRuntimeId>();
    if (provider.agentRuntimes.length === 0) {
        issues.push(issue("adapter.agent_runtime_missing", "provider must declare at least one agent runtime"));
    }
    for (const descriptor of provider.agentRuntimes) {
        if (descriptorIds.has(descriptor.agentRuntimeId)) {
            issues.push(issue("adapter.agent_runtime_duplicate", `duplicate agentRuntimeId: ${descriptor.agentRuntimeId}`));
        }
        descriptorIds.add(descriptor.agentRuntimeId);
        requireNonBlank(descriptor.agentRuntimeId, "agentRuntimeId", issues);
        requireNonBlank(descriptor.displayName, "agentRuntime.displayName", issues);
        requireAllowed(
            descriptor.entryClass,
            ENTRY_CLASSES,
            "adapter.agent_runtime_entry_class_invalid",
            "agent runtime entryClass is invalid",
            issues,
        );
    }
    for (const existing of registeredProviders) {
        for (const descriptor of existing.agentRuntimes) {
            if (descriptorIds.has(descriptor.agentRuntimeId)) {
                issues.push(
                    issue(
                        "adapter.agent_runtime_owner_conflict",
                        `agentRuntimeId ${descriptor.agentRuntimeId} is already owned by ${existing.adapterId}`,
                    ),
                );
            }
        }
    }

    if (includeSourceRead) validateSourceCapabilities(provider, descriptorIds, registeredProviders, issues);
    validateTargetSchemas(provider, descriptorIds, registeredProviders, issues);
    validateTargetCapabilities(provider, descriptorIds, issues);
    validateMaterializers(provider, registeredProviders, issues);
    validateDialectContracts(provider, registeredProviders, issues);
    return issues;
}

function validateDialectContracts(
    provider: AdapterProviderStaticDeclarations,
    registeredProviders: readonly AdapterProviderStaticDeclarations[],
    issues: OperationDiagnostic[],
): void {
    try {
        assertAdapterDialectContracts(provider.dialectContracts);
    } catch (error) {
        issues.push(issue("adapter.dialect_contract_invalid", `provider dialect contract is invalid: ${String(error)}`));
        return;
    }
    const existingNative = new Set(
        registeredProviders.flatMap((existing) =>
            existing.dialectContracts.native.map((contract) =>
                dialectKey(contract.definition.kind, contract.definition.dialectId),
            ),
        ),
    );
    const existingRestoration = new Set(
        registeredProviders.flatMap((existing) =>
            existing.dialectContracts.restoration.map((contract) =>
                dialectKey(contract.definition.kind, contract.definition.dialectId),
            ),
        ),
    );
    const existingPortableEntries = new Set(
        registeredProviders.flatMap((existing) =>
            existing.dialectContracts.portableEntries.map((contract) =>
                portableDialectKey(contract.definition.kind, contract.definition.field, contract.definition.dialectId),
            ),
        ),
    );
    const existingPortableSelectors = new Set(
        registeredProviders.flatMap((existing) =>
            existing.dialectContracts.portableSelectors.map((contract) =>
                portableDialectKey(contract.definition.kind, contract.definition.field, contract.definition.dialectId),
            ),
        ),
    );
    for (const contract of provider.dialectContracts.native) {
        const key = dialectKey(contract.definition.kind, contract.definition.dialectId);
        if (existingNative.has(key)) {
            issues.push(
                issue("adapter.native_dialect_owner_conflict", `native dialect ${key} is already owned by another adapter`),
            );
        }
    }
    for (const contract of provider.dialectContracts.restoration) {
        const key = dialectKey(contract.definition.kind, contract.definition.dialectId);
        if (existingRestoration.has(key)) {
            issues.push(
                issue(
                    "adapter.restoration_dialect_owner_conflict",
                    `restoration dialect ${key} is already owned by another adapter`,
                ),
            );
        }
    }
    const ownedAgentRuntimeIds = new Set(provider.agentRuntimes.map((descriptor) => descriptor.agentRuntimeId));
    for (const contract of provider.dialectContracts.portableEntries) {
        validatePortableDialectOwner(contract.definition, existingPortableEntries, ownedAgentRuntimeIds, "entry", issues);
    }
    for (const contract of provider.dialectContracts.portableSelectors) {
        validatePortableDialectOwner(contract.definition, existingPortableSelectors, ownedAgentRuntimeIds, "selector", issues);
    }
}

function dialectKey(kind: AssetKind, dialectId: string): string {
    return `${kind}\0${dialectId}`;
}

function portableDialectKey(kind: AssetKind, field: string, dialectId: string): string {
    return `${kind}\0${field}\0${dialectId}`;
}

function validatePortableDialectOwner(
    definition: {
        kind: AssetKind;
        field: string;
        dialectId: string;
        applicableAgentRuntimeIds: string[];
    },
    existing: ReadonlySet<string>,
    ownedAgentRuntimeIds: ReadonlySet<string>,
    family: "entry" | "selector",
    issues: OperationDiagnostic[],
): void {
    const key = portableDialectKey(definition.kind, definition.field, definition.dialectId);
    if (existing.has(key)) {
        issues.push(
            issue(
                `adapter.portable_${family}_dialect_owner_conflict`,
                `portable ${family} dialect ${key} is already owned by another adapter`,
            ),
        );
    }
    for (const agentRuntimeId of definition.applicableAgentRuntimeIds) {
        if (!ownedAgentRuntimeIds.has(agentRuntimeId)) {
            issues.push(
                issue(
                    `adapter.portable_${family}_dialect_runtime_foreign`,
                    `portable ${family} dialect ${key} names foreign agentRuntimeId ${agentRuntimeId}`,
                ),
            );
        }
    }
}

function validateSourceCapabilities(
    provider: AdapterProviderStaticDeclarations,
    descriptorIds: ReadonlySet<AgentRuntimeId>,
    registeredProviders: readonly AdapterProviderStaticDeclarations[],
    issues: OperationDiagnostic[],
): void {
    const canonicalKeys = new Set<string>();
    const fingerprints = new Set<string>(
        registeredProviders.flatMap((candidate) =>
            candidate.assetSourceCapabilities.map((row) => row.sourceCapabilityFingerprint),
        ),
    );
    for (const capability of provider.assetSourceCapabilities) {
        requireAllowed(
            capability.entrySupportStatus,
            ENTRY_SUPPORT_STATUSES,
            "adapter.source_support_status_invalid",
            "source capability support status is invalid",
            issues,
        );
        requireAllowed(
            capability.rootLocatorKind,
            ROOT_LOCATOR_KINDS,
            "adapter.source_locator_kind_invalid",
            "source capability locator kind is invalid",
            issues,
        );
        requireAllowed(
            capability.rootRole,
            ROOT_ROLES,
            "adapter.source_root_role_invalid",
            "source capability root role is invalid",
            issues,
        );
        requireAllowed(
            capability.sourceDomain,
            SOURCE_DOMAINS,
            "adapter.source_domain_invalid",
            "source capability domain is invalid",
            issues,
        );
        requireAllowed(
            capability.assetKind,
            ASSET_KINDS,
            "adapter.source_asset_kind_invalid",
            "source capability AssetKind is invalid",
            issues,
        );
        requireAllowed(
            capability.sourcePathMechanism,
            SOURCE_PATH_MECHANISMS,
            "adapter.source_path_mechanism_invalid",
            "source capability path mechanism is invalid",
            issues,
        );
        requireAllowed(
            capability.evidenceLevel,
            SOURCE_EVIDENCE_LEVELS,
            "adapter.source_evidence_level_invalid",
            "source capability evidence level is invalid",
            issues,
        );
        requireAllowed(
            capability.readPolicy,
            READ_POLICIES,
            "adapter.source_read_policy_invalid",
            "source capability read policy is invalid",
            issues,
        );
        if (!descriptorIds.has(capability.agentRuntimeId)) {
            issues.push(
                issue(
                    "adapter.source_runtime_foreign",
                    `source capability references foreign runtime ${capability.agentRuntimeId}`,
                ),
            );
            continue;
        }
        const key = stableStringify(sourceCapabilityPreimage(capability));
        if (canonicalKeys.has(key)) issues.push(issue("adapter.source_capability_duplicate", "duplicate source capability row"));
        canonicalKeys.add(key);
        const expected = computeSourceCapabilityFingerprint(provider, capability);
        if (expected === null || capability.sourceCapabilityFingerprint !== expected) {
            issues.push(
                issue(
                    "adapter.source_fingerprint_mismatch",
                    `source capability fingerprint mismatch for ${capability.agentRuntimeId}/${capability.assetKind}`,
                ),
            );
        }
        if (fingerprints.has(capability.sourceCapabilityFingerprint)) {
            issues.push(
                issue(
                    "adapter.source_fingerprint_duplicate",
                    `duplicate source capability fingerprint: ${capability.sourceCapabilityFingerprint}`,
                ),
            );
        }
        fingerprints.add(capability.sourceCapabilityFingerprint);
        if (
            capability.readPolicy === "auto_read" &&
            (capability.sourceDomain === "unknown" ||
                capability.rootLocatorKind === "unknown" ||
                capability.sourcePathMechanism === "unknown")
        ) {
            issues.push(issue("adapter.source_auto_read_unknown", "auto_read cannot use an unknown source boundary"));
        }
        requireUnavailableDiagnostic(capability.entrySupportStatus, capability.diagnostics, "source", issues);
    }
    requireCartesianCoverage(provider.agentRuntimes, provider.assetSourceCapabilities, "source", issues);
    for (const descriptor of provider.agentRuntimes) {
        for (const kind of BUILTIN_ASSET_KINDS) {
            const rows = provider.assetSourceCapabilities.filter(
                (row) => row.agentRuntimeId === descriptor.agentRuntimeId && row.assetKind === kind,
            );
            if (rows.some((row) => row.entrySupportStatus === "unsupported") && rows.length !== 1) {
                issues.push(
                    issue(
                        "adapter.source_unsupported_not_exclusive",
                        `unsupported source cell has other rows: ${descriptor.agentRuntimeId}/${kind}`,
                    ),
                );
            }
        }
    }
}

function validateTargetSchemas(
    provider: AdapterProviderStaticDeclarations,
    descriptorIds: ReadonlySet<AgentRuntimeId>,
    registeredProviders: readonly AdapterProviderStaticDeclarations[],
    issues: OperationDiagnostic[],
): void {
    const ids = new Set<string>(
        registeredProviders.flatMap((candidate) => candidate.targetContextSchemas.map((schema) => schema.targetContextSchemaId)),
    );
    const fingerprints = new Set<string>(
        registeredProviders.flatMap((candidate) => candidate.targetContextSchemas.map((schema) => schema.schemaFingerprint)),
    );
    for (const schema of provider.targetContextSchemas) {
        if (!descriptorIds.has(schema.agentRuntimeId))
            issues.push(
                issue("adapter.schema_runtime_foreign", `target schema references foreign runtime ${schema.agentRuntimeId}`),
            );
        requireNonBlank(schema.targetContextSchemaId, "targetContextSchemaId", issues);
        if (ids.has(schema.targetContextSchemaId))
            issues.push(issue("adapter.schema_id_duplicate", `duplicate target schema id: ${schema.targetContextSchemaId}`));
        ids.add(schema.targetContextSchemaId);
        if (fingerprints.has(schema.schemaFingerprint))
            issues.push(
                issue("adapter.schema_fingerprint_duplicate", `duplicate target schema fingerprint: ${schema.schemaFingerprint}`),
            );
        fingerprints.add(schema.schemaFingerprint);
        const ruleKeys = new Set<string>();
        for (const rule of schema.factRules) {
            requireNonBlank(rule.key, "targetContextSchema.factRule.key", issues);
            if (ruleKeys.has(rule.key))
                issues.push(
                    issue("adapter.schema_fact_duplicate", `schema ${schema.targetContextSchemaId} repeats fact key ${rule.key}`),
                );
            ruleKeys.add(rule.key);
            if (rule.valueKind !== "canonical_string") {
                issues.push(
                    issue(
                        "adapter.schema_fact_value_kind_invalid",
                        `schema ${schema.targetContextSchemaId} has an invalid fact value kind`,
                    ),
                );
            }
            if (
                rule.normalization.componentId.trim().length === 0 ||
                !Number.isInteger(rule.normalization.componentVersion) ||
                rule.normalization.componentVersion < 1 ||
                !isSha256Digest(rule.normalization.configFingerprint)
            ) {
                issues.push(
                    issue(
                        "adapter.schema_normalization_invalid",
                        `schema ${schema.targetContextSchemaId} has an invalid normalization component`,
                    ),
                );
            }
        }
        const expected = computeTargetContextSchemaFingerprint(provider, schema);
        if (expected === null || schema.schemaFingerprint !== expected || !isSha256Digest(schema.schemaFingerprint)) {
            issues.push(
                issue(
                    "adapter.schema_fingerprint_mismatch",
                    `target schema fingerprint mismatch: ${schema.targetContextSchemaId}`,
                ),
            );
        }
    }
}

function validateTargetCapabilities(
    provider: AdapterProviderStaticDeclarations,
    descriptorIds: ReadonlySet<AgentRuntimeId>,
    issues: OperationDiagnostic[],
): void {
    const keys = new Set<string>();
    for (const capability of provider.assetTargetCapabilities) {
        requireAllowed(
            capability.entrySupportStatus,
            ENTRY_SUPPORT_STATUSES,
            "adapter.target_support_status_invalid",
            "target capability support status is invalid",
            issues,
        );
        requireAllowed(
            capability.assetKind,
            ASSET_KINDS,
            "adapter.target_asset_kind_invalid",
            "target capability AssetKind is invalid",
            issues,
        );
        if (!descriptorIds.has(capability.agentRuntimeId)) {
            issues.push(
                issue(
                    "adapter.target_runtime_foreign",
                    `target capability references foreign runtime ${capability.agentRuntimeId}`,
                ),
            );
        }
        const key = targetCapabilityKey(capability);
        if (keys.has(key)) issues.push(issue("adapter.target_capability_duplicate", "duplicate target capability row"));
        keys.add(key);
        if (capability.entrySupportStatus === "supported" || capability.entrySupportStatus === "docs_declared_unverified") {
            requireAllowed(
                capability.renderStrategy,
                RENDER_STRATEGIES,
                "adapter.target_render_strategy_invalid",
                "target capability render strategy is invalid",
                issues,
            );
            requireAllowed(
                capability.reverseExtractPolicy,
                REVERSE_EXTRACT_POLICIES,
                "adapter.target_reverse_policy_invalid",
                "target capability reverse policy is invalid",
                issues,
            );
            requireNonBlank(capability.outputContractId, "target.outputContractId", issues);
            const schema = provider.targetContextSchemas.find(
                (candidate) => candidate.targetContextSchemaId === capability.targetContextSchemaId,
            );
            if (
                schema === undefined ||
                schema.agentRuntimeId !== capability.agentRuntimeId ||
                schema.schemaFingerprint !== capability.targetContextSchemaFingerprint
            ) {
                issues.push(
                    issue(
                        "adapter.target_schema_reference_invalid",
                        `target capability has invalid schema reference for ${capability.agentRuntimeId}/${capability.assetKind}`,
                    ),
                );
            }
            if (!isSha256Digest(capability.outputContractFingerprint)) {
                issues.push(
                    issue(
                        "adapter.target_output_fingerprint_invalid",
                        "target capability has an invalid output contract fingerprint",
                    ),
                );
            }
        }
        requireUnavailableDiagnostic(capability.entrySupportStatus, capability.diagnostics, "target", issues);
    }
    requireCartesianCoverage(provider.agentRuntimes, provider.assetTargetCapabilities, "target", issues);
    for (const descriptor of provider.agentRuntimes) {
        for (const kind of BUILTIN_ASSET_KINDS) {
            const rows = provider.assetTargetCapabilities.filter(
                (row) => row.agentRuntimeId === descriptor.agentRuntimeId && row.assetKind === kind,
            );
            if (
                rows.some((row) => row.entrySupportStatus === "unsupported" || row.entrySupportStatus === "deferred") &&
                rows.length !== 1
            ) {
                issues.push(
                    issue(
                        "adapter.target_unavailable_not_exclusive",
                        `unavailable target cell has other rows: ${descriptor.agentRuntimeId}/${kind}`,
                    ),
                );
            }
        }
    }
}

function validateMaterializers(
    provider: AdapterProviderStaticDeclarations,
    registeredProviders: readonly AdapterProviderStaticDeclarations[],
    issues: OperationDiagnostic[],
): void {
    const keys = new Set(
        registeredProviders.flatMap((candidate) =>
            candidate.materializerCapabilities.map((row) => row.materializerCapabilityKey),
        ),
    );
    for (const capability of provider.materializerCapabilities) {
        requireNonBlank(capability.materializerCapabilityKey, "materializerCapabilityKey", issues);
        requireNonBlank(capability.outputContractId, "materializer.outputContractId", issues);
        if (!isSha256Digest(capability.outputContractFingerprint))
            issues.push(issue("adapter.materializer_output_fingerprint_invalid", "materializer output fingerprint is invalid"));
        if (keys.has(capability.materializerCapabilityKey))
            issues.push(
                issue(
                    "adapter.materializer_key_duplicate",
                    `duplicate materializer key: ${capability.materializerCapabilityKey}`,
                ),
            );
        keys.add(capability.materializerCapabilityKey);
        if (
            capability.materializationProfileIds.length === 0 ||
            new Set(capability.materializationProfileIds).size !== capability.materializationProfileIds.length
        ) {
            issues.push(
                issue(
                    "adapter.materializer_profiles_invalid",
                    `materializer ${capability.materializerCapabilityKey} must declare unique non-empty profiles`,
                ),
            );
        }
        for (const profile of capability.materializationProfileIds) requireNonBlank(profile, "materializationProfileId", issues);
    }
}

function requireCartesianCoverage(
    descriptors: readonly AgentRuntimeDescriptor[],
    rows: readonly { agentRuntimeId: AgentRuntimeId; assetKind: AssetKind }[],
    side: "source" | "target",
    issues: OperationDiagnostic[],
): void {
    for (const descriptor of descriptors) {
        for (const kind of BUILTIN_ASSET_KINDS) {
            if (!rows.some((row) => row.agentRuntimeId === descriptor.agentRuntimeId && row.assetKind === kind)) {
                issues.push(
                    issue(
                        `adapter.${side}_capability_missing`,
                        `${side} capability missing for ${descriptor.agentRuntimeId}/${kind}`,
                    ),
                );
            }
        }
    }
}

function requireUnavailableDiagnostic(
    status: string,
    diagnostics: readonly OperationDiagnostic[],
    side: string,
    issues: OperationDiagnostic[],
): void {
    if (status !== "supported" && diagnostics.length === 0) {
        issues.push(issue(`adapter.${side}_diagnostic_missing`, `${side} ${status} declaration requires a diagnostic`));
    }
}

function targetCapabilityKey(capability: AdapterAssetTargetCapability): string {
    if (!("renderStrategy" in capability)) {
        return stableStringify({
            agentRuntimeId: capability.agentRuntimeId,
            assetKind: capability.assetKind,
            entrySupportStatus: capability.entrySupportStatus,
        });
    }
    return stableStringify({
        agentRuntimeId: capability.agentRuntimeId,
        assetKind: capability.assetKind,
        renderStrategy: capability.renderStrategy,
        outputContractId: capability.outputContractId,
        outputContractFingerprint: capability.outputContractFingerprint,
    });
}

export { validateAdapterProbeResult } from "./adapter-probe-validator";
