import { describe, expect, it } from "vitest";
import {
    computeSourceCapabilityFingerprint,
    computeTargetContextSchemaFingerprint,
    validateAdapterProviderRegistration,
} from "../../src/adapters/adapter-contract-validator";
import { createAdapterAssetSourceCapability } from "../../src/adapters/adapter-source-capability";
import type { AdapterId, AdapterProvider } from "../../src/types";
import { addValidTargetSchemaAndMaterializer, makeContractProvider } from "./fixtures/adapter-contract-fixtures";
import {
    makeNativeDialectContract,
    makePortableEntryDialectContract,
    makePortableSelectorDialectContract,
    makeRestorationDialectContract,
} from "../source-import/fixtures/dialect-contracts";

const A = "VALIDATOR_A" as AdapterId;
const B = "VALIDATOR_B" as AdapterId;

function codes(diagnostics: ReturnType<typeof validateAdapterProviderRegistration>): string[] {
    return diagnostics.map((item) => item.code);
}

describe("adapter static-contract validator", () => {
    it("accepts complete Cartesian declarations and exact static fingerprints", () => {
        const provider = makeContractProvider(A);
        expect(validateAdapterProviderRegistration(provider, [])).toEqual([]);
        for (const row of provider.assetSourceCapabilities) {
            expect(computeSourceCapabilityFingerprint(provider, row)).toBe(row.sourceCapabilityFingerprint);
        }
    });

    it("constructs a source row without adapter-owned fingerprint mechanics", () => {
        const provider = makeContractProvider(A);
        const { sourceCapabilityFingerprint: _discarded, ...input } = provider.assetSourceCapabilities[0]!;
        const capability = createAdapterAssetSourceCapability(provider, input);
        expect(capability).toEqual({
            ...input,
            sourceCapabilityFingerprint: computeSourceCapabilityFingerprint(provider, input),
        });
        expect(input).not.toHaveProperty("sourceCapabilityFingerprint");
        expect(() =>
            createAdapterAssetSourceCapability(provider, {
                ...input,
                agentRuntimeId: "FOREIGN_RUNTIME",
            }),
        ).toThrow(/unknown agentRuntimeId/);
    });

    it("rejects malformed, unversioned, duplicate-owner dialect declarations", () => {
        const malformed = makeContractProvider(A);
        malformed.dialectContracts.native.push(makeNativeDialectContract("Guidance", "unversioned-v1"));
        malformed.dialectContracts.native[0]!.definition.dialectId = "unversioned";
        expect(codes(validateAdapterProviderRegistration(malformed, []))).toContain("adapter.dialect_contract_invalid");

        const existing = makeContractProvider(A);
        existing.dialectContracts.native.push(makeNativeDialectContract("Guidance", "shared-guidance-v1"));
        existing.dialectContracts.restoration.push(makeRestorationDialectContract("Memory", "shared-memory-v1"));
        existing.dialectContracts.portableEntries.push(
            makePortableEntryDialectContract("Workflow", "workflow_instruction", "shared-workflow-entry-v1", () => true, [
                `${A}_CLI`,
            ]),
        );
        existing.dialectContracts.portableSelectors.push(
            makePortableSelectorDialectContract("Workflow", "workflow_model", "shared-workflow-model-v1", () => true, [
                `${A}_CLI`,
            ]),
        );
        const conflicting = makeContractProvider(B);
        conflicting.dialectContracts.native.push(makeNativeDialectContract("Guidance", "shared-guidance-v1"));
        conflicting.dialectContracts.restoration.push(
            makeRestorationDialectContract("Memory", "shared-memory-v1"),
            makeRestorationDialectContract("Memory", "provider-b-only-memory-v1"),
        );
        conflicting.dialectContracts.portableEntries.push(
            makePortableEntryDialectContract("Workflow", "workflow_instruction", "shared-workflow-entry-v1", () => true, [
                `${B}_CLI`,
            ]),
        );
        conflicting.dialectContracts.portableSelectors.push(
            makePortableSelectorDialectContract("Workflow", "workflow_model", "shared-workflow-model-v1", () => true, [
                `${B}_CLI`,
            ]),
            makePortableSelectorDialectContract("Workflow", "workflow_model", "provider-b-model-v1", () => true, [`${A}_CLI`]),
        );
        expect(codes(validateAdapterProviderRegistration(conflicting, [existing]))).toEqual(
            expect.arrayContaining([
                "adapter.native_dialect_owner_conflict",
                "adapter.restoration_dialect_owner_conflict",
                "adapter.portable_entry_dialect_owner_conflict",
                "adapter.portable_selector_dialect_owner_conflict",
                "adapter.portable_selector_dialect_runtime_foreign",
            ]),
        );
    });

    it("accepts a valid target schema, supported target row, and materializer declaration", () => {
        const provider = addValidTargetSchemaAndMaterializer(makeContractProvider(A));
        provider.targetContextSchemas[0]!.factRules.push({
            key: "alpha",
            valueKind: "canonical_string",
            normalization: {
                componentId: "oaam.text.canonical",
                componentVersion: 1,
                configFingerprint: `sha256:${"3".repeat(64)}`,
            },
        });
        provider.targetContextSchemas[0]!.factRules.push({
            key: "zulu",
            valueKind: "canonical_string",
            normalization: {
                componentId: "oaam.text.canonical",
                componentVersion: 1,
                configFingerprint: `sha256:${"4".repeat(64)}`,
            },
        });
        provider.targetContextSchemas[0]!.schemaFingerprint = computeTargetContextSchemaFingerprint(
            provider,
            provider.targetContextSchemas[0]!,
        )!;
        const target = provider.assetTargetCapabilities[0]!;
        if ("targetContextSchemaFingerprint" in target) {
            target.targetContextSchemaFingerprint = provider.targetContextSchemas[0]!.schemaFingerprint;
        }
        const source = provider.assetSourceCapabilities[0]!;
        Object.assign(source, {
            entrySupportStatus: "supported",
            rootLocatorKind: "runtime_known_rule",
            rootRole: "source",
            sourceDomain: "agent_runtime_private",
            sourcePathMechanism: "fixed_file",
            evidenceLevel: "agent_runtime_verified",
            readPolicy: "auto_read",
            diagnostics: [],
        });
        source.sourceCapabilityFingerprint = computeSourceCapabilityFingerprint(provider, source)!;
        expect(computeTargetContextSchemaFingerprint(provider, provider.targetContextSchemas[0]!)).toBe(
            provider.targetContextSchemas[0]?.schemaFingerprint,
        );
        expect(validateAdapterProviderRegistration(provider, [])).toEqual([]);
    });

    it("rejects runtime enum values outside the frozen static contract", () => {
        const staticCases: Array<[string, (provider: AdapterProvider) => void]> = [
            [
                "adapter.agent_runtime_entry_class_invalid",
                (provider) => {
                    provider.agentRuntimes[0]!.entryClass = "service" as never;
                },
            ],
            [
                "adapter.source_support_status_invalid",
                (provider) => {
                    provider.assetSourceCapabilities[0]!.entrySupportStatus = "maybe" as never;
                },
            ],
            [
                "adapter.source_locator_kind_invalid",
                (provider) => {
                    provider.assetSourceCapabilities[0]!.rootLocatorKind = "cwd" as never;
                },
            ],
            [
                "adapter.source_root_role_invalid",
                (provider) => {
                    provider.assetSourceCapabilities[0]!.rootRole = "install" as never;
                },
            ],
            [
                "adapter.source_domain_invalid",
                (provider) => {
                    provider.assetSourceCapabilities[0]!.sourceDomain = "plugin" as never;
                },
            ],
            [
                "adapter.source_asset_kind_invalid",
                (provider) => {
                    provider.assetSourceCapabilities[0]!.assetKind = "Plugin" as never;
                },
            ],
            [
                "adapter.source_path_mechanism_invalid",
                (provider) => {
                    provider.assetSourceCapabilities[0]!.sourcePathMechanism = "glob" as never;
                },
            ],
            [
                "adapter.source_evidence_level_invalid",
                (provider) => {
                    provider.assetSourceCapabilities[0]!.evidenceLevel = "assumed" as never;
                },
            ],
            [
                "adapter.source_read_policy_invalid",
                (provider) => {
                    provider.assetSourceCapabilities[0]!.readPolicy = "read_everything" as never;
                },
            ],
        ];
        for (const [expectedCode, mutate] of staticCases) {
            const provider = makeContractProvider(A);
            mutate(provider);
            const source = provider.assetSourceCapabilities[0]!;
            source.sourceCapabilityFingerprint = computeSourceCapabilityFingerprint(provider, source)!;
            expect(codes(validateAdapterProviderRegistration(provider, []))).toContain(expectedCode);
        }

        const provider = addValidTargetSchemaAndMaterializer(makeContractProvider(A));
        provider.targetContextSchemas[0]!.factRules[0]!.valueKind = "freeform" as never;
        const target = provider.assetTargetCapabilities[0]!;
        if (!("renderStrategy" in target)) throw new Error("fixture target must be available");
        target.assetKind = "Plugin" as never;
        target.renderStrategy = "symlink" as never;
        target.reverseExtractPolicy = "guess" as never;
        expect(codes(validateAdapterProviderRegistration(provider, []))).toEqual(
            expect.arrayContaining([
                "adapter.schema_fact_value_kind_invalid",
                "adapter.target_asset_kind_invalid",
                "adapter.target_render_strategy_invalid",
                "adapter.target_reverse_policy_invalid",
            ]),
        );
        const invalidStatusProvider = makeContractProvider(B);
        invalidStatusProvider.assetTargetCapabilities[0]!.entrySupportStatus = "maybe" as never;
        expect(codes(validateAdapterProviderRegistration(invalidStatusProvider, []))).toContain(
            "adapter.target_support_status_invalid",
        );
    });

    it("rejects empty identity and a provider with no runtime or Cartesian declarations", () => {
        const provider = makeContractProvider(A);
        Object.assign(provider, {
            adapterId: "",
            displayName: " ",
            version: "",
            agentRuntimes: [],
            assetSourceCapabilities: [],
            assetTargetCapabilities: [],
        });
        const result = codes(validateAdapterProviderRegistration(provider, []));
        expect(result.filter((code) => code === "adapter.noncanonical_text")).toHaveLength(3);
        expect(result).toContain("adapter.agent_runtime_missing");
    });

    it("rejects duplicate/foreign source rows, stale fingerprints, unsafe auto-read, and missing diagnostics", () => {
        const existing = makeContractProvider(A);
        const provider = makeContractProvider(B);
        provider.agentRuntimes.push({ ...provider.agentRuntimes[0]! });
        provider.agentRuntimes[0]!.displayName = "";
        provider.agentRuntimes[0]!.agentRuntimeId = existing.agentRuntimes[0]!.agentRuntimeId;
        provider.agentRuntimes[1]!.agentRuntimeId = existing.agentRuntimes[0]!.agentRuntimeId;
        const foreignRow = {
            ...provider.assetSourceCapabilities[0]!,
            agentRuntimeId: "FOREIGN_RUNTIME",
        };
        const row = {
            ...provider.assetSourceCapabilities[0]!,
            agentRuntimeId: existing.agentRuntimes[0]!.agentRuntimeId,
            sourceCapabilityFingerprint: existing.assetSourceCapabilities[0]!.sourceCapabilityFingerprint,
            readPolicy: "auto_read" as const,
            diagnostics: [],
        };
        provider.assetSourceCapabilities = [foreignRow, row, { ...row }, { ...row, entrySupportStatus: "unsupported" }];
        provider.assetTargetCapabilities = [
            {
                agentRuntimeId: "FOREIGN_RUNTIME",
                entrySupportStatus: "deferred",
                assetKind: "Guidance",
                diagnostics: [],
            },
            {
                agentRuntimeId: existing.agentRuntimes[0]!.agentRuntimeId,
                entrySupportStatus: "deferred",
                assetKind: "Guidance",
                diagnostics: [],
            },
            {
                agentRuntimeId: existing.agentRuntimes[0]!.agentRuntimeId,
                entrySupportStatus: "deferred",
                assetKind: "Guidance",
                diagnostics: [],
            },
        ];
        const result = codes(validateAdapterProviderRegistration(provider, [existing]));
        expect(result).toEqual(
            expect.arrayContaining([
                "adapter.agent_runtime_duplicate",
                "adapter.agent_runtime_owner_conflict",
                "adapter.source_runtime_foreign",
                "adapter.source_capability_duplicate",
                "adapter.source_fingerprint_duplicate",
                "adapter.source_auto_read_unknown",
                "adapter.source_diagnostic_missing",
                "adapter.source_unsupported_not_exclusive",
                "adapter.source_capability_missing",
                "adapter.target_runtime_foreign",
                "adapter.target_capability_duplicate",
                "adapter.target_diagnostic_missing",
                "adapter.target_unavailable_not_exclusive",
                "adapter.target_capability_missing",
            ]),
        );
    });

    it("rejects malformed schemas, target references, and materializer declarations including global collisions", () => {
        const existing = addValidTargetSchemaAndMaterializer(makeContractProvider(A));
        const provider = addValidTargetSchemaAndMaterializer(makeContractProvider(B));
        const existingSchema = existing.targetContextSchemas[0]!;
        const schema = provider.targetContextSchemas[0]!;
        Object.assign(schema, {
            targetContextSchemaId: existingSchema.targetContextSchemaId,
            schemaFingerprint: existingSchema.schemaFingerprint,
            agentRuntimeId: "FOREIGN_RUNTIME",
            factRules: [
                { ...schema.factRules[0]!, key: "" },
                { ...schema.factRules[0]!, key: "" },
            ],
        });
        schema.factRules[0]!.normalization.componentVersion = 0;
        provider.targetContextSchemas.push({
            ...schema,
            targetContextSchemaId: "duplicate-facts",
            agentRuntimeId: provider.agentRuntimes[0]!.agentRuntimeId,
            factRules: [...schema.factRules],
        });
        provider.assetTargetCapabilities[0] = {
            agentRuntimeId: provider.agentRuntimes[0]!.agentRuntimeId,
            entrySupportStatus: "supported",
            assetKind: "Guidance",
            renderStrategy: "inline",
            outputContractId: "",
            outputContractFingerprint: "bad",
            targetContextSchemaId: "missing",
            targetContextSchemaFingerprint: "bad",
            reverseExtractPolicy: "can_reconcile",
            diagnostics: [],
        };
        provider.materializerCapabilities[0] = {
            materializerCapabilityKey: existing.materializerCapabilities[0]!.materializerCapabilityKey,
            outputContractId: "",
            outputContractFingerprint: "bad",
            materializationProfileIds: ["", ""],
            diagnostics: [],
        };
        const result = codes(validateAdapterProviderRegistration(provider, [existing]));
        expect(result).toEqual(
            expect.arrayContaining([
                "adapter.schema_runtime_foreign",
                "adapter.schema_id_duplicate",
                "adapter.schema_fingerprint_duplicate",
                "adapter.schema_fact_duplicate",
                "adapter.schema_normalization_invalid",
                "adapter.schema_fingerprint_mismatch",
                "adapter.target_schema_reference_invalid",
                "adapter.target_output_fingerprint_invalid",
                "adapter.materializer_key_duplicate",
                "adapter.materializer_output_fingerprint_invalid",
                "adapter.materializer_profiles_invalid",
                "adapter.noncanonical_text",
            ]),
        );
    });

    it("returns null when a fingerprint row names no descriptor", () => {
        const provider = makeContractProvider(A);
        expect(
            computeSourceCapabilityFingerprint(provider, {
                ...provider.assetSourceCapabilities[0]!,
                agentRuntimeId: "FOREIGN_RUNTIME",
            }),
        ).toBeNull();
        expect(
            computeTargetContextSchemaFingerprint(provider, {
                targetContextSchemaId: "foreign",
                schemaFingerprint: `sha256:${"1".repeat(64)}`,
                agentRuntimeId: "FOREIGN_RUNTIME",
                factRules: [],
                diagnostics: [],
            }),
        ).toBeNull();
    });
});
