import { describe, expect, it } from "vitest";
import { createRenderRegistry } from "../../src/render/render-registry";
import {
    computeConsumerConformanceFingerprint,
    computeMaterializationProfileConstraintFingerprint,
    computeOutputContractFingerprint,
    computeRenderRegistryFingerprint,
} from "../../src/foundation/fingerprint";
import type { AdapterProviderSummary, ConsumerOutputContractConformanceV1, OutputContractDefinitionV1 } from "../../src/types";
import {
    OUTPUT_CONTRACT_ID,
    PROFILE_ID,
    RENDER_ADAPTER_ID,
    RENDER_RUNTIME_ID,
    component,
    makeConformances,
    makeMaterializationValidator,
    makeOutputContract,
    makeOutputUnit,
    makeProviderSummary,
    makeRenderRegistry,
    makeReverseInspectionValidator,
    makeTargetContext,
} from "./fixtures/render-contract-fixtures";

function registryConfiguration(
    input: {
        providers?: AdapterProviderSummary[];
        contract?: OutputContractDefinitionV1;
        conformances?: ConsumerOutputContractConformanceV1[];
        predicate?: boolean;
    } = {},
) {
    const contract = input.contract ?? makeOutputContract();
    const providers = input.providers ?? [makeProviderSummary({ contract })];
    return {
        providers,
        outputContracts: [contract],
        consumerConformances: input.conformances ?? providers.flatMap((provider) => makeConformances(provider, contract)),
        targetApplicabilityPredicates: [
            {
                ref: component("oaam.test.applicable", `sha256:${"3".repeat(64)}`),
                evaluate: () => input.predicate ?? true,
            },
        ],
        materializationValidators: [makeMaterializationValidator(contract)],
        reverseInspectionValidators: [makeReverseInspectionValidator(contract)],
    };
}

describe("render registry authority", () => {
    it("freezes one exact registry and resolves target capability plus current renderer", () => {
        const contract = makeOutputContract();
        const provider = makeProviderSummary({ contract });
        const registry = createRenderRegistry(registryConfiguration({ providers: [provider], contract }));
        const context = makeTargetContext(provider);
        const unit = makeOutputUnit(contract);

        expect(registry.getProvider(RENDER_ADAPTER_ID)?.version).toBe("1.0.0");
        expect(registry.getOwner(RENDER_RUNTIME_ID)?.adapterId).toBe(RENDER_ADAPTER_ID);
        expect(registry.getDescriptor(RENDER_RUNTIME_ID)?.entryClass).toBe("cli");
        expect(registry.getOutputContract(OUTPUT_CONTRACT_ID)).toEqual(contract);
        expect(registry.getProvider("UNKNOWN")).toBeNull();
        expect(registry.getOwner("UNKNOWN")).toBeNull();
        expect(registry.getDescriptor("UNKNOWN")).toBeNull();
        expect(registry.getOutputContract("UNKNOWN_V1")).toBeNull();
        expect(() => registry.validateTargetContext(context)).not.toThrow();
        expect(
            registry.findTargetCapability({
                provider: registry.getProvider(RENDER_ADAPTER_ID)!,
                agentRuntimeId: RENDER_RUNTIME_ID,
                assetKind: "Guidance",
                renderStrategy: "inline",
                outputContractId: contract.outputContractId,
                outputContractFingerprint: contract.outputContractFingerprint,
            }),
        ).not.toBeNull();
        expect(
            registry.findTargetCapability({
                provider: registry.getProvider(RENDER_ADAPTER_ID)!,
                agentRuntimeId: RENDER_RUNTIME_ID,
                assetKind: "Memory",
                renderStrategy: "inline",
                outputContractId: contract.outputContractId,
                outputContractFingerprint: contract.outputContractFingerprint,
            }),
        ).toBeNull();
        const ambiguous = structuredClone(provider);
        ambiguous.assetTargetCapabilities.push(structuredClone(ambiguous.assetTargetCapabilities[0]!));
        expect(() =>
            registry.findTargetCapability({
                provider: ambiguous,
                agentRuntimeId: RENDER_RUNTIME_ID,
                assetKind: "Guidance",
                renderStrategy: "inline",
                outputContractId: contract.outputContractId,
                outputContractFingerprint: contract.outputContractFingerprint,
            }),
        ).toThrow(/ambiguous/);
        expect(registry.findMaterializerCandidates(unit, [{ context, assetKind: "Guidance", renderStrategy: "inline" }])).toEqual(
            [
                expect.objectContaining({
                    rendererAdapterId: RENDER_ADAPTER_ID,
                    materializationProfileId: PROFILE_ID,
                }),
            ],
        );
        expect(
            registry.findMaterializerCandidates({ ...unit, outputContractId: "UNKNOWN_V1" }, [
                { context, assetKind: "Guidance", renderStrategy: "inline" },
            ]),
        ).toEqual([]);
        expect(registry.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

        provider.version = "mutated-after-snapshot";
        provider.assetTargetCapabilities.length = 0;
        expect(registry.getProvider(RENDER_ADAPTER_ID)?.version).toBe("1.0.0");
        expect(registry.listProviders()[0]?.assetTargetCapabilities).toHaveLength(1);
        expect(() => {
            registry.listProviders()[0]!.version = "illegal";
        }).toThrow();
    });

    it("excludes enabled state and diagnostics from the semantic registry fingerprint", () => {
        const contract = makeOutputContract();
        const provider = makeProviderSummary({ contract });
        const conformances = makeConformances(provider, contract);
        const first = computeRenderRegistryFingerprint({
            providers: [provider],
            outputContracts: [contract],
            consumerConformances: conformances,
        });
        provider.enabled = false;
        provider.targetContextSchemas[0]!.diagnostics = [
            {
                severity: "warning",
                code: "display-only",
                message: "display-only",
                path: "",
                traceId: "",
                operation: "render",
                causeKind: "partial",
                retryable: false,
                suggestedActions: [],
                rawSummary: "",
            },
        ];
        provider.assetTargetCapabilities[0]!.diagnostics = provider.targetContextSchemas[0]!.diagnostics;
        provider.materializerCapabilities[0]!.diagnostics = provider.targetContextSchemas[0]!.diagnostics;
        expect(
            computeRenderRegistryFingerprint({
                providers: [provider],
                outputContracts: [contract],
                consumerConformances: conformances,
            }),
        ).toBe(first);
    });

    it("returns no renderer when the exact contract, build, predicate, or enabled producer is absent", () => {
        const contract = makeOutputContract();
        const provider = makeProviderSummary({ contract });
        const context = makeTargetContext(provider);
        const unit = makeOutputUnit(contract);
        const requirement = [{ context, assetKind: "Guidance" as const, renderStrategy: "inline" as const }];

        expect(
            makeRenderRegistry({
                providers: [provider],
                contract,
                predicateResult: false,
            }).findMaterializerCandidates(unit, requirement),
        ).toEqual([]);
        const registry = makeRenderRegistry({ providers: [provider], contract });
        expect(
            registry.findMaterializerCandidates({ ...unit, outputContractFingerprint: `sha256:${"f".repeat(64)}` }, requirement),
        ).toEqual([]);
        expect(
            registry.findMaterializerCandidates(unit, [
                { ...requirement[0]!, context: { ...context, buildIdentity: "another-build" } },
            ]),
        ).toEqual([]);
        const disabled = makeProviderSummary({ contract, enabled: false });
        expect(makeRenderRegistry({ providers: [disabled], contract }).findMaterializerCandidates(unit, requirement)).toEqual([]);
    });

    it("sorts multiple contracts and exact renderer candidates while skipping another contract", () => {
        const contract = makeOutputContract();
        const secondContract = makeOutputContract();
        secondContract.outputContractId = "OAAM_TEST_SECOND_V1";
        const { outputContractFingerprint: _stored, ...secondPreimage } = secondContract;
        secondContract.outputContractFingerprint = computeOutputContractFingerprint(secondPreimage);
        for (const profile of secondContract.materializationProfiles) {
            profile.profileConstraintFingerprint = computeMaterializationProfileConstraintFingerprint({
                outputContractFingerprint: secondContract.outputContractFingerprint,
                materializationProfileId: profile.materializationProfileId,
                constraintValidator: profile.constraintValidator,
            });
        }
        const first = makeProviderSummary({ contract });
        const second = makeProviderSummary({
            adapterId: "ZZZ" as never,
            agentRuntimeId: "ZZZ_CLI" as never,
            contract,
        });
        first.materializerCapabilities.push({
            ...first.materializerCapabilities[0]!,
            materializerCapabilityKey: "ignored.second.contract",
            outputContractId: secondContract.outputContractId,
            outputContractFingerprint: secondContract.outputContractFingerprint,
        });
        const registry = createRenderRegistry({
            ...registryConfiguration({ providers: [second, first], contract }),
            outputContracts: [secondContract, contract],
            consumerConformances: [...makeConformances(first, contract), ...makeConformances(second, contract)],
        });
        const candidates = registry.findMaterializerCandidates(makeOutputUnit(contract), [
            {
                context: makeTargetContext(first),
                assetKind: "Guidance",
                renderStrategy: "inline",
            },
        ]);
        expect(candidates.map((item) => item.rendererAdapterId)).toEqual([first.adapterId, second.adapterId]);
    });
});

describe("render registry rejects malformed static facts", () => {
    it("requires one unique implementation for both output-contract validators", () => {
        const configuration = registryConfiguration();
        expect(() => createRenderRegistry({ ...configuration, materializationValidators: [] })).toThrow(
            /materialization validator is not registered/,
        );
        expect(() => createRenderRegistry({ ...configuration, reverseInspectionValidators: [] })).toThrow(
            /reverse inspection validator is not registered/,
        );
        expect(() =>
            createRenderRegistry({
                ...configuration,
                materializationValidators: [
                    configuration.materializationValidators[0]!,
                    configuration.materializationValidators[0]!,
                ],
            }),
        ).toThrow(/duplicate materialization validator/);
    });

    it("captures validator functions so caller mutation cannot rewrite a frozen registry", () => {
        const configuration = registryConfiguration();
        const registry = createRenderRegistry(configuration);
        const contract = configuration.outputContracts[0]!;
        const profile = contract.materializationProfiles[0]!;
        const outputUnit = makeOutputUnit(contract);
        configuration.materializationValidators[0]!.validate = () => {
            throw new Error("mutated materialization validator");
        };
        configuration.reverseInspectionValidators[0]!.validate = () => {
            throw new Error("mutated reverse validator");
        };
        expect(() =>
            registry.validateOutputContractMaterialization({
                contract,
                profile,
                outputUnit,
                selectedSemantics: [],
                canonicalValues: [],
                selectedOptions: [],
                files: [],
            }),
        ).not.toThrow();
        expect(() =>
            registry.validateOutputContractReverseInspection({
                contract,
                outputUnit,
                appliedRenderSnapshot: {} as never,
                inspectionScopeFingerprint: `sha256:${"1".repeat(64)}`,
                files: [],
                inventoryDeltas: [],
                adapterResult: { status: "complete", changes: [], files: [], diagnostics: [] },
            }),
        ).not.toThrow();
    });

    it("rejects materialization and reverse-validator inputs from a foreign contract snapshot", () => {
        const registry = makeRenderRegistry();
        const contract = makeOutputContract();
        const profile = contract.materializationProfiles[0]!;
        const foreign = {
            ...contract,
            outputContractFingerprint: `sha256:${"f".repeat(64)}`,
        };
        expect(() =>
            registry.validateOutputContractMaterialization({
                contract: foreign,
                profile,
            } as never),
        ).toThrow(/materialization validator input is not from this registry/);
        expect(() =>
            registry.validateOutputContractMaterialization({
                contract,
                profile: {
                    ...profile,
                    profileConstraintFingerprint: `sha256:${"f".repeat(64)}`,
                },
            } as never),
        ).toThrow(/materialization validator input is not from this registry/);
        expect(() => registry.validateOutputContractReverseInspection({ contract: foreign } as never)).toThrow(
            /reverse inspection validator input is not from this registry/,
        );
    });

    it("rejects duplicate provider IDs and agent-runtime owners", () => {
        const contract = makeOutputContract();
        const first = makeProviderSummary({ contract });
        const duplicateId = makeProviderSummary({ contract });
        expect(() => createRenderRegistry(registryConfiguration({ providers: [first, duplicateId], contract }))).toThrow(
            /duplicate provider adapterId/,
        );

        const otherId = makeProviderSummary({
            adapterId: "OTHER" as never,
            agentRuntimeId: RENDER_RUNTIME_ID,
            contract,
        });
        expect(() => createRenderRegistry(registryConfiguration({ providers: [first, otherId], contract }))).toThrow(
            /duplicate agent-runtime owner/,
        );
    });

    it("rejects invalid output contract identity, components, profiles, and fingerprints", () => {
        const cases: Array<[RegExp, (contract: OutputContractDefinitionV1) => void]> = [
            [
                /invalid OutputContractId/,
                (contract) => {
                    contract.schemaVersion = 2 as never;
                },
            ],
            [
                /invalid OutputContractId/,
                (contract) => {
                    contract.outputContractId = "bad";
                },
            ],
            [
                /componentVersion/,
                (contract) => {
                    contract.pathAndFileGrammar.componentVersion = 0;
                },
            ],
            [
                /configFingerprint/,
                (contract) => {
                    contract.pathAndFileGrammar.configFingerprint = "bad" as never;
                },
            ],
            [
                /requires a materialization profile/,
                (contract) => {
                    contract.materializationProfiles = [];
                },
            ],
            [
                /duplicate profile/,
                (contract) => {
                    contract.materializationProfiles.push({
                        ...contract.materializationProfiles[0]!,
                    });
                },
            ],
            [
                /output contract fingerprint mismatch/,
                (contract) => {
                    contract.outputContractFingerprint = `sha256:${"f".repeat(64)}`;
                },
            ],
            [
                /profile constraint fingerprint mismatch/,
                (contract) => {
                    contract.materializationProfiles[0]!.profileConstraintFingerprint = `sha256:${"f".repeat(64)}`;
                },
            ],
        ];
        for (const [message, mutate] of cases) {
            const contract = makeOutputContract();
            mutate(contract);
            expect(() => createRenderRegistry(registryConfiguration({ contract }))).toThrow(message);
        }
    });

    it("rejects malformed provider schema, target, and materializer references", () => {
        const contract = makeOutputContract();
        const cases: Array<[RegExp, (provider: AdapterProviderSummary) => void]> = [
            [
                /duplicate target context schema/,
                (provider) => provider.targetContextSchemas.push({ ...provider.targetContextSchemas[0]! }),
            ],
            [
                /schema fingerprint/,
                (provider) => {
                    provider.targetContextSchemas[0]!.schemaFingerprint = "bad" as never;
                },
            ],
            [
                /duplicate target context fact key/,
                (provider) =>
                    provider.targetContextSchemas[0]!.factRules.push({
                        ...provider.targetContextSchemas[0]!.factRules[0]!,
                    }),
            ],
            [
                /componentVersion/,
                (provider) => {
                    provider.targetContextSchemas[0]!.factRules[0]!.normalization.componentVersion = 0;
                },
            ],
            [
                /duplicate target capability/,
                (provider) =>
                    provider.assetTargetCapabilities.push({
                        ...provider.assetTargetCapabilities[0]!,
                    }),
            ],
            [
                /materializer profiles/,
                (provider) => {
                    provider.materializerCapabilities[0]!.materializationProfileIds = [];
                },
            ],
            [
                /unknown profile/,
                (provider) => {
                    provider.materializerCapabilities[0]!.materializationProfileIds = ["missing"];
                },
            ],
        ];
        for (const [message, mutate] of cases) {
            const provider = makeProviderSummary({ contract });
            mutate(provider);
            expect(() => createRenderRegistry(registryConfiguration({ providers: [provider], contract }))).toThrow(message);
        }

        const unknownContractProvider = makeProviderSummary({ contract });
        if ("outputContractId" in unknownContractProvider.assetTargetCapabilities[0]!) {
            unknownContractProvider.assetTargetCapabilities[0]!.outputContractId = "UNKNOWN_V1";
        }
        expect(() =>
            createRenderRegistry({
                ...registryConfiguration({ providers: [unknownContractProvider], contract }),
                consumerConformances: [],
            }),
        ).toThrow(/unknown output contract/);

        const unknownMaterializerContract = makeProviderSummary({ contract });
        unknownMaterializerContract.materializerCapabilities[0]!.outputContractId = "UNKNOWN_V1";
        expect(() =>
            createRenderRegistry(
                registryConfiguration({
                    providers: [unknownMaterializerContract],
                    contract,
                }),
            ),
        ).toThrow(/materializer references an unknown output contract/);
    });

    it("rejects duplicate materializer keys across otherwise distinct providers", () => {
        const contract = makeOutputContract();
        const first = makeProviderSummary({ contract });
        const second = makeProviderSummary({
            adapterId: "OTHER" as never,
            agentRuntimeId: "OTHER_CLI" as never,
            contract,
        });
        second.materializerCapabilities[0]!.materializerCapabilityKey =
            first.materializerCapabilities[0]!.materializerCapabilityKey;
        expect(() => createRenderRegistry(registryConfiguration({ providers: [first, second], contract }))).toThrow(
            /duplicate materializer capability key/,
        );
    });

    it("rejects unverified, malformed, duplicated, or unbound conformance rows", () => {
        const contract = makeOutputContract();
        const provider = makeProviderSummary({ contract });
        const base = makeConformances(provider, contract)[0]!;
        const cases: Array<[RegExp, (row: ConsumerOutputContractConformanceV1) => void]> = [
            [
                /unknown consumer/,
                (row) => {
                    row.agentRuntimeId = "UNKNOWN";
                },
            ],
            [
                /unknown output contract\/profile/,
                (row) => {
                    row.outputContractId = "UNKNOWN_V1";
                },
            ],
            [
                /predicate is not registered/,
                (row) => {
                    row.targetApplicabilityPredicate = component("unknown", `sha256:${"9".repeat(64)}`);
                },
            ],
            [
                /buildIdentity/,
                (row) => {
                    row.buildIdentity = "";
                },
            ],
            [
                /verified passing fixture/,
                (row) => {
                    row.evidenceLevel = "docs_declared" as never;
                },
            ],
            [
                /verified passing fixture/,
                (row) => {
                    row.status = "failed" as never;
                },
            ],
            [
                /verified passing fixture/,
                (row) => {
                    row.fixtureSetFingerprint = "bad" as never;
                },
            ],
            [
                /no supported consumer target capability/,
                (row) => {
                    row.assetKind = "Memory";
                },
            ],
            [
                /target schema does not match/,
                (row) => {
                    row.targetContextSchemaFingerprint = `sha256:${"9".repeat(64)}`;
                },
            ],
            [
                /conformance fingerprint mismatch/,
                (row) => {
                    row.conformanceFingerprint = `sha256:${"9".repeat(64)}`;
                },
            ],
        ];
        for (const [message, mutate] of cases) {
            const row = structuredClone(base);
            mutate(row);
            expect(() =>
                createRenderRegistry(registryConfiguration({ providers: [provider], contract, conformances: [row] })),
            ).toThrow(message);
        }
        expect(() =>
            createRenderRegistry(
                registryConfiguration({
                    providers: [provider],
                    contract,
                    conformances: [base, structuredClone(base)],
                }),
            ),
        ).toThrow(/duplicate consumer conformance/);
    });

    it("rejects a conformance fingerprint recomputed for a foreign target schema", () => {
        const contract = makeOutputContract();
        const provider = makeProviderSummary({ contract });
        const row = makeConformances(provider, contract)[0]!;
        row.targetContextSchemaFingerprint = `sha256:${"9".repeat(64)}`;
        const { conformanceFingerprint: _stored, ...preimage } = row;
        row.conformanceFingerprint = computeConsumerConformanceFingerprint({
            conformance: preimage,
            entryClass: "cli",
        });
        expect(() =>
            createRenderRegistry(
                registryConfiguration({
                    providers: [provider],
                    contract,
                    conformances: [row],
                }),
            ),
        ).toThrow(/target schema does not match/);
    });
});

describe("target render context validation", () => {
    it("rejects unknown owners, schema drift, missing facts, noncanonical values, and fingerprint drift", () => {
        const contract = makeOutputContract();
        const provider = makeProviderSummary({ contract });
        const registry = makeRenderRegistry({ providers: [provider], contract });
        const base = makeTargetContext(provider);
        const cases: Array<[RegExp, (context: typeof base) => void]> = [
            [
                /schemaVersion/,
                (context) => {
                    context.schemaVersion = 2 as never;
                },
            ],
            [
                /no owner/,
                (context) => {
                    context.agentRuntimeId = "UNKNOWN";
                },
            ],
            [
                /schema does not match/,
                (context) => {
                    context.targetContextSchemaId = "unknown";
                },
            ],
            [
                /versionText/,
                (context) => {
                    context.versionText = "";
                },
            ],
            [
                /buildIdentity/,
                (context) => {
                    context.buildIdentity = "";
                },
            ],
            [
                /exact key set/,
                (context) => {
                    context.renderFacts = [];
                },
            ],
            [
                /exact key set/,
                (context) => {
                    context.renderFacts.push({ ...context.renderFacts[0]! });
                },
            ],
            [
                /canonical and recognized/,
                (context) => {
                    context.renderFacts[0]!.value = " padded ";
                },
            ],
            [
                /canonical and recognized/,
                (context) => {
                    context.renderFacts[0]!.evidenceLevel = "imagined" as never;
                },
            ],
            [
                /fingerprint mismatch/,
                (context) => {
                    context.targetApplicabilityFingerprint = `sha256:${"9".repeat(64)}`;
                },
            ],
        ];
        for (const [message, mutate] of cases) {
            const context = structuredClone(base);
            mutate(context);
            expect(() => registry.validateTargetContext(context)).toThrow(message);
        }
    });

    it("treats the same semantic contract/profile fingerprint as stable under array reordering", () => {
        const contract = makeOutputContract();
        contract.materializationProfiles.push({
            materializationProfileId: "second",
            profileConstraintFingerprint: "" as never,
            constraintValidator: component("oaam.test.second", `sha256:${"8".repeat(64)}`),
        });
        const { outputContractFingerprint: _stored, ...preimage } = contract;
        contract.outputContractFingerprint = computeOutputContractFingerprint(preimage);
        for (const profile of contract.materializationProfiles) {
            profile.profileConstraintFingerprint = computeMaterializationProfileConstraintFingerprint({
                outputContractFingerprint: contract.outputContractFingerprint,
                materializationProfileId: profile.materializationProfileId,
                constraintValidator: profile.constraintValidator,
            });
        }
        const reversed = structuredClone(contract);
        reversed.materializationProfiles.reverse();
        const { outputContractFingerprint: _ignored, ...reversedPreimage } = reversed;
        expect(computeOutputContractFingerprint(reversedPreimage)).toBe(contract.outputContractFingerprint);
    });
});
