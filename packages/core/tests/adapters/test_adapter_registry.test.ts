/** Static adapter registration, snapshot, bootstrap, and freeze-contract tests. */

import { beforeEach, describe, expect, it } from "vitest";
import {
    bootstrapAdapterRegistry,
    clearRegistry,
    disableAdapter,
    enableAdapter,
    freezeRegistry,
    getRegisteredVersionDialectRegistry,
    getRegisteredCanonicalMaterializationValidators,
    listAdapterProviders,
    probeAdapters,
    registerAdapterProvider,
    replaceEnabledAdapters,
    resolveRegisteredSourceCapabilityAgentRuntimeId,
    unfreezeRegistry,
} from "../../src/orchestration/adapter-registry";
import type { AdapterId, AdapterProvider, PlatformContext } from "../../src/types";
import { makeContractProvider } from "./fixtures/adapter-contract-fixtures";
import { makeNativeGuidanceProvider } from "./fixtures/adapter-registry-providers";
import { makeNativeDialectContract } from "../source-import/fixtures/dialect-contracts";

const A = "MOCK_A" as AdapterId;
const B = "MOCK_B" as AdapterId;
const LINUX: PlatformContext = {
    platform: "linux",
    platformInstanceId: "local",
    accessRootPath: "/",
};

describe("adapter registry final static contract", () => {
    beforeEach(() => clearRegistry());

    it("binds render checker assembly to a frozen registry with exact Provider ownership and version", () => {
        expect(() => getRegisteredCanonicalMaterializationValidators([])).toThrow(/frozen/);
        expect(registerAdapterProvider(makeNativeGuidanceProvider(A)).status).toBe("complete");
        freezeRegistry();
        const summaries = listAdapterProviders().value;
        expect(getRegisteredCanonicalMaterializationValidators(summaries).get(A)).toEqual([]);
        for (const summary of [
            { ...summaries[0]!, adapterId: B },
            { ...summaries[0]!, version: "stale-version" },
        ]) {
            expect(() => getRegisteredCanonicalMaterializationValidators([summary])).toThrow(/does not match/);
        }
    });

    it("registers an immutable disabled snapshot and returns non-authoritative summary copies", () => {
        const provider = makeContractProvider(A);
        const result = registerAdapterProvider(provider);
        expect(result.status).toBe("complete");
        const expected = structuredClone({
            adapterId: A,
            displayName: provider.displayName,
            version: "2.3.4",
            enabled: false,
            agentRuntimes: provider.agentRuntimes,
            targetContextSchemas: provider.targetContextSchemas,
            assetSourceCapabilities: provider.assetSourceCapabilities,
            assetTargetCapabilities: provider.assetTargetCapabilities,
            materializerCapabilities: provider.materializerCapabilities,
            renderContractDeclarations: provider.renderContractDeclarations,
        });
        expect(result.value).toEqual(expected);

        provider.version = "caller-mutated";
        provider.agentRuntimes.length = 0;
        provider.assetSourceCapabilities.length = 0;
        result.value.agentRuntimes.length = 0;
        result.value.assetTargetCapabilities.length = 0;

        expect(listAdapterProviders().value).toEqual([expected]);
    });

    it("snapshots an adapter-owned render declaration before caller mutation", () => {
        const provider = makeNativeGuidanceProvider(A);
        const expected = structuredClone(provider.renderContractDeclarations);
        expect(registerAdapterProvider(provider).status).toBe("complete");

        const declaration = provider.renderContractDeclarations[0];
        if (declaration?.declarationKind !== "native_project_guidance_v1") {
            throw new Error("native Guidance declaration fixture is missing");
        }
        declaration.target.relativePath = "CALLER-MUTATED.md";
        declaration.verifiedBuilds.length = 0;

        expect(listAdapterProviders().value[0]?.renderContractDeclarations).toEqual(expected);
    });

    it("rejects adapter-owned render declarations that disagree with registered capabilities", () => {
        const mutations: ((provider: AdapterProvider) => void)[] = [
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration !== undefined) {
                    (declaration as { schemaVersion: number }).schemaVersion = 2;
                }
            },
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration !== undefined) {
                    (declaration as { declarationKind: string }).declarationKind = "unknown";
                }
            },
            (provider) => {
                provider.renderContractDeclarations.push(structuredClone(provider.renderContractDeclarations[0]!));
            },
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_guidance_v1") {
                    declaration.target.relativePath = "MISMATCH.md";
                }
            },
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_guidance_v1") {
                    declaration.materializationProfileId = "profile\0invalid";
                }
            },
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_guidance_v1") {
                    declaration.outputContractId = "MISMATCH_OUTPUT_CONTRACT_V1";
                }
            },
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_guidance_v1") {
                    declaration.materializationProfileId = "mismatch-profile-v1";
                }
            },
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_guidance_v1") {
                    declaration.agentRuntimeId = "FOREIGN_RUNTIME";
                }
            },
            (provider) => {
                provider.targetContextSchemas = [];
            },
            (provider) => {
                provider.targetContextSchemas.push(structuredClone(provider.targetContextSchemas[0]!));
            },
            (provider) => {
                provider.targetContextSchemas[0]!.factRules = [];
            },
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_guidance_v1") {
                    declaration.target.requiredFacts = { "different.fact": "linux" };
                }
            },
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_guidance_v1") {
                    declaration.target.requiredFacts = {
                        "oaam.platform": "linux",
                        "unexpected.fact": "present",
                    };
                }
            },
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_guidance_v1") {
                    declaration.target.requiredFacts = { "oaam.target-kind": "unknown" };
                }
            },
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_guidance_v1") {
                    declaration.verifiedBuilds = [];
                }
            },
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_guidance_v1") {
                    declaration.target.relativePath = "../escape.md";
                }
            },
            (provider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_guidance_v1") {
                    declaration.verifiedBuilds.push(structuredClone(declaration.verifiedBuilds[0]!));
                }
            },
            (provider) => {
                provider.materializerCapabilities = [];
            },
            (provider) => {
                const target = provider.assetTargetCapabilities.find(
                    (capability) => capability.entrySupportStatus === "supported",
                );
                if (target !== undefined && "reverseExtractPolicy" in target) {
                    target.reverseExtractPolicy = "unsupported";
                }
            },
        ];

        for (const mutate of mutations) {
            const provider = makeNativeGuidanceProvider(A);
            mutate(provider);
            const result = registerAdapterProvider(provider);
            expect(result.status).toBe("failed");
            expect(result.diagnostics.some((item) => item.code === "adapter.render_contract_invalid")).toBe(true);
            expect(listAdapterProviders().value).toEqual([]);
            clearRegistry();
        }
    });

    it("rejects declaration-free target and orphan materializer rows instead of filtering them out", () => {
        const owner = makeNativeGuidanceProvider(A);
        const foreignTarget = makeNativeGuidanceProvider(B);
        foreignTarget.renderContractDeclarations = [];
        foreignTarget.materializerCapabilities = [];
        const ownerTarget = owner.assetTargetCapabilities.find((capability) => capability.entrySupportStatus === "supported");
        const target = foreignTarget.assetTargetCapabilities.find((capability) => capability.entrySupportStatus === "supported");
        if (
            ownerTarget === undefined ||
            target === undefined ||
            !("outputContractId" in ownerTarget) ||
            !("outputContractId" in target)
        ) {
            throw new Error("native target fixtures are missing");
        }
        target.outputContractId = ownerTarget.outputContractId;
        target.outputContractFingerprint = ownerTarget.outputContractFingerprint;

        expect(bootstrapAdapterRegistry([owner, foreignTarget]).status).toBe("failed");
        expect(listAdapterProviders().value).toEqual([]);

        const orphanRenderer = makeContractProvider(B);
        orphanRenderer.materializerCapabilities = structuredClone(owner.materializerCapabilities);
        expect(registerAdapterProvider(orphanRenderer).status).toBe("failed");
        expect(listAdapterProviders().value).toEqual([]);
    });

    it("bootstraps a cross-provider consumer and materializer only after the whole set closes", () => {
        for (const reverseOrder of [false, true]) {
            clearRegistry();
            const consumer = makeNativeGuidanceProvider(A);
            const renderer = makeContractProvider(B);
            renderer.materializerCapabilities = structuredClone(consumer.materializerCapabilities);
            consumer.materializerCapabilities = [];
            const providers = reverseOrder ? [renderer, consumer] : [consumer, renderer];

            expect(bootstrapAdapterRegistry(providers).status).toBe("complete");
            expect(
                listAdapterProviders()
                    .value.map((provider) => provider.adapterId)
                    .sort(),
            ).toEqual([A, B].sort());
        }

        clearRegistry();
        const consumer = makeNativeGuidanceProvider(A);
        const renderer = makeContractProvider(B);
        renderer.materializerCapabilities = structuredClone(consumer.materializerCapabilities);
        consumer.materializerCapabilities = [];
        expect(registerAdapterProvider(consumer).status).toBe("failed");
        expect(listAdapterProviders().value).toEqual([]);
        expect(registerAdapterProvider(renderer).status).toBe("failed");
        expect(listAdapterProviders().value).toEqual([]);
    });

    it("captures provider method identity at registration", async () => {
        const provider = makeContractProvider(A);
        const originalProbe = provider.probe;
        let originalCalls = 0;
        let replacementCalls = 0;
        provider.probe = async (context) => {
            originalCalls += 1;
            return originalProbe(context);
        };
        expect(registerAdapterProvider(provider).status).toBe("complete");
        provider.probe = async (context) => {
            replacementCalls += 1;
            return originalProbe(context);
        };
        expect(enableAdapter(A).status).toBe("complete");

        expect(
            (
                await probeAdapters({
                    adapterIds: [A],
                    contexts: [LINUX],
                    target: { authorizationScope: "global" },
                })
            ).status,
        ).toBe("complete");
        expect({ originalCalls, replacementCalls }).toEqual({
            originalCalls: 1,
            replacementCalls: 0,
        });
    });

    it("assembles frozen dialect validators independently of adapter enablement", () => {
        const provider = makeContractProvider(A);
        const contract = makeNativeDialectContract("Guidance", "mock-guidance-v1");
        provider.dialectContracts.native.push(contract);
        const registered = registerAdapterProvider(provider);
        expect(registered.status).toBe("complete");
        expect("dialectContracts" in registered.value).toBe(false);
        expect(() => getRegisteredVersionDialectRegistry()).toThrow(/must be frozen/);
        expect(freezeRegistry().status).toBe("complete");

        contract.definition.dialectId = "caller-mutated-v2";
        const dialects = getRegisteredVersionDialectRegistry();
        expect(freezeRegistry().status).toBe("complete");
        expect(getRegisteredVersionDialectRegistry()).toBe(dialects);
        expect(dialects.getNative("Guidance", "mock-guidance-v1")).not.toBeNull();
        expect(dialects.getNative("Guidance", "caller-mutated-v2")).toBeNull();
        expect(disableAdapter(A).status).toBe("complete");
        expect(getRegisteredVersionDialectRegistry().getNative("Guidance", "mock-guidance-v1")).not.toBeNull();
    });

    it("resolves source-capability ownership only from a registered provider snapshot", () => {
        const provider = makeContractProvider(A);
        const capability = provider.assetSourceCapabilities[0];
        if (capability === undefined) throw new Error("source capability fixture is missing");
        expect(resolveRegisteredSourceCapabilityAgentRuntimeId(A, capability.sourceCapabilityFingerprint)).toBeNull();
        expect(registerAdapterProvider(provider).status).toBe("complete");
        expect(resolveRegisteredSourceCapabilityAgentRuntimeId(A, capability.sourceCapabilityFingerprint)).toBe(
            capability.agentRuntimeId,
        );
        expect(resolveRegisteredSourceCapabilityAgentRuntimeId(A, `sha256:${"f".repeat(64)}`)).toBeNull();
    });

    it("rejects an invalid provider atomically before it can enter the registry", () => {
        const provider = makeContractProvider(A);
        provider.assetSourceCapabilities = provider.assetSourceCapabilities.slice(1);
        const result = registerAdapterProvider(provider);
        expect(result.status).toBe("failed");
        expect(result.diagnostics.some((item) => item.code === "adapter.source_capability_missing")).toBe(true);
        expect(listAdapterProviders().value).toEqual([]);
    });

    it("returns a typed failure for a runtime-malformed provider instead of throwing", () => {
        const provider = makeContractProvider(A);
        (provider as unknown as { agentRuntimes: null }).agentRuntimes = null;
        const result = registerAdapterProvider(provider);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("adapter_registration_invalid");
        expect(listAdapterProviders().value).toEqual([]);
    });

    it("rejects duplicate adapter IDs, freezes registration, and permits the test-only reset", () => {
        expect(registerAdapterProvider(makeContractProvider(A)).status).toBe("complete");
        expect(registerAdapterProvider(makeContractProvider(A)).diagnostics[0]?.code).toBe("duplicate_adapter");
        expect(freezeRegistry().status).toBe("complete");
        expect(registerAdapterProvider(makeContractProvider(B)).diagnostics[0]?.code).toBe("registry_frozen");
        unfreezeRegistry();
        expect(registerAdapterProvider(makeContractProvider(B)).status).toBe("complete");
    });

    it("enable and disable alter authorization only and reject unknown adapters", () => {
        expect(enableAdapter(A).diagnostics[0]?.code).toBe("not_found");
        expect(disableAdapter(A).diagnostics[0]?.code).toBe("not_found");
        registerAdapterProvider(makeContractProvider(A));
        expect(enableAdapter(A).status).toBe("complete");
        expect(listAdapterProviders().value[0]?.enabled).toBe(true);
        expect(disableAdapter(A).status).toBe("complete");
        expect(listAdapterProviders().value[0]?.enabled).toBe(false);
    });

    it("bootstraps the frozen provider set atomically or leaves the registry empty", () => {
        const first = makeContractProvider(A);
        const duplicate = makeContractProvider(A);
        expect(bootstrapAdapterRegistry([first, duplicate]).status).toBe("failed");
        expect(listAdapterProviders().value).toEqual([]);
        expect(registerAdapterProvider(makeContractProvider(B)).status).toBe("complete");

        clearRegistry();
        expect(bootstrapAdapterRegistry([first]).status).toBe("complete");
        expect(listAdapterProviders().value).toEqual([expect.objectContaining({ adapterId: A, enabled: false })]);
        expect(replaceEnabledAdapters([B]).diagnostics[0]?.code).toBe("adapter_enablement_unknown");
        expect(listAdapterProviders().value).toEqual([expect.objectContaining({ adapterId: A, enabled: false })]);
        expect(replaceEnabledAdapters([A]).status).toBe("complete");
        expect(listAdapterProviders().value).toEqual([expect.objectContaining({ adapterId: A, enabled: true })]);
        expect(getRegisteredVersionDialectRegistry()).toBeDefined();
        expect(registerAdapterProvider(makeContractProvider(B)).diagnostics[0]?.code).toBe("registry_frozen");
    });

    it("rejects every invalid bootstrap precondition without publishing a partial provider set", () => {
        const first = makeContractProvider(A);
        expect(registerAdapterProvider(makeContractProvider(B)).status).toBe("complete");
        expect(bootstrapAdapterRegistry([first]).diagnostics[0]?.code).toBe("registry_not_empty");

        clearRegistry();
        const incomplete = makeContractProvider(A);
        incomplete.assetSourceCapabilities = incomplete.assetSourceCapabilities.slice(1);
        expect(bootstrapAdapterRegistry([incomplete]).status).toBe("failed");
        expect(listAdapterProviders().value).toEqual([]);

        const throwing = makeContractProvider(A);
        Object.defineProperty(throwing, "adapterId", {
            get() {
                throw new Error("unreadable provider identity");
            },
        });
        expect(bootstrapAdapterRegistry([throwing]).diagnostics[0]?.code).toBe("adapter_bootstrap_invalid");
        expect(listAdapterProviders().value).toEqual([]);
    });

    it("replaces the frozen live enablement projection atomically", () => {
        expect(replaceEnabledAdapters([]).diagnostics[0]?.code).toBe("registry_not_frozen");
        expect(bootstrapAdapterRegistry([makeContractProvider(A), makeContractProvider(B)]).status).toBe("complete");
        expect(replaceEnabledAdapters([A, A]).diagnostics[0]?.code).toBe("adapter_enablement_duplicate");
        expect(replaceEnabledAdapters([A, "UNKNOWN" as AdapterId]).diagnostics[0]?.code).toBe("adapter_enablement_unknown");
        expect(listAdapterProviders().value.every((provider) => !provider.enabled)).toBe(true);
        expect(replaceEnabledAdapters([B]).status).toBe("complete");
        expect(listAdapterProviders().value).toEqual([
            expect.objectContaining({ adapterId: A, enabled: false }),
            expect.objectContaining({ adapterId: B, enabled: true }),
        ]);
    });
});
