/** Deployment, render, materialization and inspection fingerprint authority scenarios. */

import { describe, expect, it } from "vitest";
import {
    computeAppliedInputsSnapshotFingerprint,
    computeAttributedSemanticChangeFingerprint,
    computeCanonicalRenderSemanticValueFingerprint,
    computeCompilationFingerprint,
    computeConsumerConformanceFingerprint,
    computeDeploymentAuthorityFingerprint,
    computeGlobalPromotionTargetAuthorityFingerprint,
    computeMaterializationFingerprint,
    computeMaterializationProfileConstraintFingerprint,
    computeOutputContractFingerprint,
    computeProviderRenderDialectInputFingerprint,
    computeRenderApprovalFingerprint,
    computeRenderDegradationFingerprint,
    computeRenderedTargetAttributeChangeFingerprint,
    computeRenderedTargetDiffHunkFingerprint,
    computeRenderedTargetInspectionResultFingerprint,
    computeRenderedTargetInspectionScopeFingerprint,
    computeRenderedTargetInventoryDeltaFingerprint,
    computeRenderInputFingerprint,
    computeRenderObservationSelectionFingerprint,
    computeRenderOptionFingerprint,
    computeRenderOutputUnitFingerprint,
    computeRenderRegistryFingerprint,
    computeRenderSelectionFingerprint,
    computeReverseInspectionCoverageFingerprint,
    computeSemanticCoverageFingerprint,
    computeSemanticRefFingerprint,
    computeTargetApplicabilityFingerprint,
} from "../../src/foundation/fingerprint";
import { makeTextFile } from "../catalog/fixtures/version-v2";
import {
    component,
    makeConformances,
    makeGuidanceRenderAsset,
    makeOutputContract,
    makeOutputUnit,
    makeProviderSummary,
    makeRenderDeployment,
    makeRenderRegistry,
    makeTargetContext,
} from "./fixtures/render-contract-fixtures";

describe("V2 deployment and render fingerprint registry", () => {
    it("canonicalizes Deployment authority assets by order and stable identity", () => {
        const base = {
            deploymentId: "11111111-1111-4111-8111-111111111111" as const,
            deleted: false,
            platform: "linux" as const,
            platformInstanceId: "local-linux",
            targetRootPath: "/project",
            projectId: "22222222-2222-4222-8222-222222222222",
            consumerAgentRuntimeIds: ["Z", "A"],
            appliedCompilationFingerprint: `sha256:${"1".repeat(64)}` as const,
            committedTransactionId: "33333333-3333-4333-8333-333333333333" as const,
            renderRegistryFingerprint: `sha256:${"2".repeat(64)}` as const,
            freshRenderInputFingerprint: `sha256:${"3".repeat(64)}` as const,
        };
        const assets = [
            {
                assetId: "55555555-5555-4555-8555-555555555555" as const,
                versionId: "66666666-6666-4666-8666-666666666666" as const,
                sortOrder: 2,
                allowIncomplete: false,
                deleted: false,
            },
            {
                assetId: "44444444-4444-4444-8444-444444444444" as const,
                versionId: "77777777-7777-4777-8777-777777777777" as const,
                sortOrder: 2,
                allowIncomplete: false,
                deleted: false,
            },
            {
                assetId: "88888888-8888-4888-8888-888888888888" as const,
                versionId: "99999999-9999-4999-8999-999999999999" as const,
                sortOrder: 1,
                allowIncomplete: false,
                deleted: false,
            },
        ];
        expect(computeDeploymentAuthorityFingerprint({ ...base, deploymentAssets: assets })).toBe(
            computeDeploymentAuthorityFingerprint({
                ...base,
                consumerAgentRuntimeIds: ["A", "Z"],
                deploymentAssets: [...assets].reverse(),
            }),
        );
        expect(computeDeploymentAuthorityFingerprint({ ...base, deploymentAssets: assets })).not.toBe(
            computeDeploymentAuthorityFingerprint({
                ...base,
                platformInstanceId: "other-linux",
                deploymentAssets: assets,
            }),
        );
    });

    it("canonicalizes every A6 multi-item materialization and inspection preimage", () => {
        const hash = (digit: string) => `sha256:${digit.repeat(64)}` as const;
        const semantic = {
            consumerAgentRuntimeId: "RUNTIME",
            subject: {
                subjectKind: "asset" as const,
                assetId: "11111111-1111-4111-8111-111111111111",
                versionId: "22222222-2222-4222-8222-222222222222",
            },
            semanticKind: "asset.file_inventory" as const,
            semanticRefFingerprint: hash("1"),
        };
        const inventoryValue = {
            semanticRefFingerprint: hash("1"),
            valueKind: "file_inventory" as const,
            value: [
                {
                    fileId: "44444444-4444-4444-8444-444444444444",
                    logicalPath: "z.md",
                    role: "resource",
                    contentKind: "text",
                    contentHash: hash("4"),
                    executable: false,
                },
                {
                    fileId: "33333333-3333-4333-8333-333333333333",
                    logicalPath: "a.md",
                    role: "entry",
                    contentKind: "binary",
                    contentHash: hash("3"),
                    executable: true,
                },
            ],
        };
        expect(
            computeCanonicalRenderSemanticValueFingerprint({
                semantic,
                assetKind: "Guidance",
                value: inventoryValue as never,
            }),
        ).toMatch(/^sha256:/);

        const files = [
            {
                relativePath: "z.md",
                content: { contentKind: "binary" as const, bytes: new Uint8Array([2]) },
                executable: true,
                semanticRefFingerprints: [hash("2"), hash("1")],
                sectionBindings: [
                    { sectionHandle: "z", semanticRefFingerprints: [hash("2")] },
                    { sectionHandle: "a", semanticRefFingerprints: [hash("1")] },
                ],
            },
            {
                relativePath: "a.md",
                content: { contentKind: "text" as const, text: "a" },
                executable: false,
                semanticRefFingerprints: [hash("1")],
                sectionBindings: [],
            },
        ];
        expect(
            computeMaterializationFingerprint({
                rendererAdapterId: "A",
                rendererAdapterVersion: "1",
                renderInputFingerprint: hash("1"),
                selectionFingerprint: hash("2"),
                outputUnitFingerprint: hash("3"),
                materializerCapabilityKey: "a.materializer",
                materializationProfileId: "default",
                profileConstraintFingerprint: hash("4"),
                providerRenderDialectInputFingerprint: hash("5"),
                files,
            } as never),
        ).toMatch(/^sha256:/);
        expect(
            computeSemanticCoverageFingerprint({
                outputContractFingerprint: hash("1"),
                profileConstraintFingerprint: hash("2"),
                outputUnitFingerprint: hash("3"),
                canonicalValues: [{ canonicalValueFingerprint: hash("2") }, { canonicalValueFingerprint: hash("1") }],
                files,
                coveredSemanticRefFingerprints: [hash("2"), hash("1")],
            } as never),
        ).toMatch(/^sha256:/);
        expect(
            computeCompilationFingerprint({
                deploymentId: "11111111-1111-4111-8111-111111111111",
                renderInputFingerprint: hash("1"),
                selectionFingerprint: hash("2"),
                units: [
                    {
                        outputUnitFingerprint: hash("4"),
                        materializationFingerprint: hash("5"),
                        semanticCoverageFingerprint: hash("6"),
                    },
                    {
                        outputUnitFingerprint: hash("3"),
                        materializationFingerprint: hash("4"),
                        semanticCoverageFingerprint: hash("5"),
                    },
                ],
                files: files.map((file, index) => ({
                    ...file,
                    outputUnitFingerprint: hash(String(index + 1)),
                    materializationFingerprint: hash(String(index + 3)),
                })),
            } as never),
        ).toMatch(/^sha256:/);

        const hunks = ["2", "1"].map((digit, index) => ({
            hunkFingerprint: hash(digit),
            appliedStartByte: index,
            appliedEndByte: index + 1,
            currentStartByte: index,
            currentEndByte: index + 1,
        }));
        const attributes = ["2", "1"].map((digit) => ({
            attributeChangeFingerprint: hash(digit),
            attributeKind: "executable" as const,
            appliedValue: false,
            currentValue: true,
        }));
        const deltas = ["2", "1"].map((digit) => ({
            inventoryDeltaFingerprint: hash(digit),
            outputUnitFingerprint: hash("3"),
            relativePath: `${digit}.md`,
            deltaKind: "file_added" as const,
            inventorySemanticRefFingerprint: hash("4"),
        }));
        const changes = ["2", "1"].map((digit) => ({
            changeKind: "file_content_replacement" as const,
            changeFingerprint: hash(digit),
            semanticRefFingerprints: [hash("4")],
            replacementContent: { contentKind: "text" as const, text: digit },
        }));
        const attributionFiles = ["z.md", "a.md"].map((relativePath) => ({
            relativePath,
            attributionState: "whole_file_adoption_required" as const,
            diagnostics: [],
        }));
        expect(
            computeRenderedTargetInspectionScopeFingerprint({
                deploymentId: "11111111-1111-4111-8111-111111111111",
                appliedCompilationFingerprint: hash("1"),
                scope: {
                    fileStates: [{ relativePath: "z.md" }, { relativePath: "a.md" }],
                    directoryInventories: [
                        {
                            outputUnitFingerprint: hash("2"),
                            boundary: { relativePath: "z", boundaryKind: "directory_inventory" },
                            currentDescendantPaths: ["z/b", "z/a"],
                        },
                        {
                            outputUnitFingerprint: hash("1"),
                            boundary: { relativePath: "a", boundaryKind: "directory_inventory" },
                            currentDescendantPaths: [],
                        },
                    ],
                },
            } as never),
        ).toMatch(/^sha256:/);
        expect(
            computeReverseInspectionCoverageFingerprint({
                outputContractFingerprint: hash("1"),
                outputUnitFingerprint: hash("2"),
                inspectionScopeFingerprint: hash("3"),
                diffHunks: hunks,
                attributeChanges: attributes,
                inventoryDeltas: deltas,
                changes,
                files: attributionFiles,
                proof: {
                    outputUnitFingerprint: hash("2"),
                    coveredHunkFingerprints: [hash("2"), hash("1")],
                    coveredAttributeChangeFingerprints: [hash("2"), hash("1")],
                    coveredInventoryDeltaFingerprints: [hash("2"), hash("1")],
                    coveredChangeFingerprints: [hash("2"), hash("1")],
                },
            } as never),
        ).toMatch(/^sha256:/);
        expect(
            computeRenderedTargetInspectionResultFingerprint({
                inspectionScopeFingerprint: hash("1"),
                changes,
                files: attributionFiles,
                reverseCoverageProofs: [{ outputUnitFingerprint: hash("2") }, { outputUnitFingerprint: hash("1") }],
            } as never),
        ).toMatch(/^sha256:/);
        expect(
            computeAttributedSemanticChangeFingerprint({
                inspectionScopeFingerprint: hash("1"),
                change: {
                    changeKind: "file_content_replacement",
                    semanticRefFingerprints: [hash("2"), hash("1")],
                    replacementContent: { contentKind: "text", text: "x" },
                },
            }),
        ).toMatch(/^sha256:/);
        expect(
            computeRenderedTargetDiffHunkFingerprint({
                relativePath: "a.md",
                appliedContentHash: hash("1"),
                currentContentHash: hash("2"),
                diffAlgorithmVersion: "v1",
                hunk: hunks[0] as never,
            }),
        ).toMatch(/^sha256:/);
        expect(
            computeRenderedTargetAttributeChangeFingerprint({
                relativePath: "a.md",
                inspectionScopeFingerprint: hash("1"),
                change: attributes[0] as never,
            }),
        ).toMatch(/^sha256:/);
        expect(
            computeRenderedTargetInventoryDeltaFingerprint({
                inspectionScopeFingerprint: hash("1"),
                delta: deltas[0] as never,
            }),
        ).toMatch(/^sha256:/);
    });

    it("binds the complete applied Deployment input snapshot", () => {
        const base = {
            schemaVersion: 1 as const,
            deploymentId: "11111111-1111-4111-8111-111111111111",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [
                {
                    assetId: "22222222-2222-4222-8222-222222222222",
                    versionId: "33333333-3333-4333-8333-333333333333",
                    allowIncomplete: false,
                },
            ],
        };
        expect(computeAppliedInputsSnapshotFingerprint(base)).not.toBe(
            computeAppliedInputsSnapshotFingerprint({
                ...base,
                assets: [{ ...base.assets[0], allowIncomplete: true }],
            }),
        );
    });

    it("canonicalizes every render registry/input/selection set and operation-local payload byte receipt", () => {
        const contract = makeOutputContract();
        contract.materializationProfiles.push({
            materializationProfileId: "second",
            profileConstraintFingerprint: `sha256:${"1".repeat(64)}`,
            constraintValidator: component("oaam.test.second", `sha256:${"2".repeat(64)}`),
        });
        const { outputContractFingerprint: _oldContract, ...contractPreimage } = contract;
        contract.outputContractFingerprint = computeOutputContractFingerprint(contractPreimage);
        for (const profile of contract.materializationProfiles) {
            profile.profileConstraintFingerprint = computeMaterializationProfileConstraintFingerprint({
                outputContractFingerprint: contract.outputContractFingerprint,
                materializationProfileId: profile.materializationProfileId,
                constraintValidator: profile.constraintValidator,
            });
        }
        const first = makeProviderSummary({ contract });
        first.agentRuntimes.push({
            agentRuntimeId: "RENDER_FIXTURE_APP",
            displayName: "App",
            entryClass: "app",
        });
        first.targetContextSchemas.push({
            ...first.targetContextSchemas[0]!,
            targetContextSchemaId: "RENDER_FIXTURE.target.second",
            agentRuntimeId: "RENDER_FIXTURE_APP",
            factRules: [
                { ...first.targetContextSchemas[0]!.factRules[0]!, key: "zulu" },
                { ...first.targetContextSchemas[0]!.factRules[0]!, key: "alpha" },
            ],
        });
        first.assetTargetCapabilities.push({
            ...first.assetTargetCapabilities[0]!,
            agentRuntimeId: "RENDER_FIXTURE_APP",
        } as never);
        first.materializerCapabilities[0]!.materializationProfileIds = ["second", "default"];
        const second = makeProviderSummary({
            adapterId: "SECOND" as never,
            agentRuntimeId: "SECOND_CLI" as never,
            contract,
        });
        const providers = [first, second];
        const conformances = providers.flatMap((provider) => makeConformances(provider, contract));
        const registryFingerprint = computeRenderRegistryFingerprint({
            providers,
            outputContracts: [contract, { ...contract, outputContractId: "OAAM_TEST_SECOND_V1" }],
            consumerConformances: conformances,
        });
        expect(
            computeRenderRegistryFingerprint({
                providers: [...providers].reverse(),
                outputContracts: [contract, { ...contract, outputContractId: "OAAM_TEST_SECOND_V1" }].reverse(),
                consumerConformances: [...conformances].reverse(),
            }),
        ).toBe(registryFingerprint);

        const context = makeTargetContext(makeProviderSummary({ contract }));
        context.renderFacts.push({
            key: "alpha",
            value: "one",
            evidenceLevel: "agent_runtime_verified",
        });
        const applicability = computeTargetApplicabilityFingerprint({
            context: { ...context, renderFacts: [...context.renderFacts].reverse() },
            entryClass: "cli",
        });
        expect(applicability).toMatch(/^sha256:/);
        expect(
            computeGlobalPromotionTargetAuthorityFingerprint({
                platform: "linux",
                platformInstanceId: "local-linux",
                targetRootPath: "/tmp/target",
                consumerAgentRuntimeIds: ["B", "A"],
            }),
        ).toBe(
            computeGlobalPromotionTargetAuthorityFingerprint({
                platform: "linux",
                platformInstanceId: "local-linux",
                targetRootPath: "/tmp/target",
                consumerAgentRuntimeIds: ["A", "B"],
            }),
        );
        expect(
            computeGlobalPromotionTargetAuthorityFingerprint({
                platform: "linux",
                platformInstanceId: "other-linux",
                targetRootPath: "/tmp/target",
                consumerAgentRuntimeIds: ["A", "B"],
            }),
        ).not.toBe(
            computeGlobalPromotionTargetAuthorityFingerprint({
                platform: "linux",
                platformInstanceId: "local-linux",
                targetRootPath: "/tmp/target",
                consumerAgentRuntimeIds: ["A", "B"],
            }),
        );

        const semanticA = {
            consumerAgentRuntimeId: "A",
            subject: {
                subjectKind: "asset" as const,
                assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            },
            semanticKind: "guidance.base_context" as const,
        };
        expect(computeSemanticRefFingerprint(semanticA)).toMatch(/^sha256:/);
        const unitA = makeOutputUnit(contract, "z.md");
        unitA.claims.push({ relativePath: "a.md", contentKind: "text", executable: false });
        unitA.managedDirectoryBoundaries = [
            { relativePath: "z-dir", boundaryKind: "directory_inventory" },
            { relativePath: "a-dir", boundaryKind: "directory_inventory" },
        ];
        const { outputUnitFingerprint: _oldUnit, ...unitPreimage } = unitA;
        const unitFingerprint = computeRenderOutputUnitFingerprint(unitPreimage);
        expect(
            computeRenderOutputUnitFingerprint({
                ...unitPreimage,
                claims: [...unitPreimage.claims].reverse(),
                managedDirectoryBoundaries: [...unitPreimage.managedDirectoryBoundaries].reverse(),
            }),
        ).toBe(unitFingerprint);

        const provider = makeProviderSummary({ contract });
        const conformance = makeConformances(provider, contract)[0]!;
        const { conformanceFingerprint: _oldConformance, ...conformancePreimage } = conformance;
        expect(
            computeConsumerConformanceFingerprint({
                conformance: conformancePreimage,
                entryClass: "cli",
            }),
        ).toBe(conformance.conformanceFingerprint);

        const text = makeTextFile("hello", "z.md");
        const binaryBytes = Uint8Array.of(1, 2, 3);
        const dialectInputs = [
            {
                consumerAgentRuntimeIds: ["FIXTURE_CLI"],
                targetVersion: {
                    assetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    versionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                },
                inputs: [
                    {
                        inputKind: "native_representation" as const,
                        inputRole: "parent_rebase_seed" as const,
                        sourceVersion: {
                            assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                            versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                        },
                        representation: {
                            schemaVersion: 1 as const,
                            dialectId: "native",
                            dialectContractFingerprint: `sha256:${"3".repeat(64)}` as const,
                            canonicalContentFingerprint: `sha256:${"4".repeat(64)}` as const,
                            representationFingerprint: `sha256:${"5".repeat(64)}` as const,
                        },
                        files: [
                            {
                                relativePath: "z.bin",
                                contentKind: "binary" as const,
                                mediaType: "application/octet-stream",
                                contentHash: `sha256:${"6".repeat(64)}` as const,
                                byteSize: binaryBytes.byteLength,
                                executable: false,
                                bytes: binaryBytes,
                            },
                            {
                                ...text.file,
                                relativePath: "a.md",
                                contentKind: "text" as const,
                                text: text.text,
                            },
                        ],
                    },
                    {
                        inputKind: "dialect_restoration" as const,
                        restoration: {
                            dialectId: "restore",
                            restorationContractFingerprint: `sha256:${"7".repeat(64)}` as const,
                            contentHash: `sha256:${"8".repeat(64)}` as const,
                        },
                        content: { contentKind: "binary" as const, bytes: binaryBytes },
                    },
                ],
            },
            {
                consumerAgentRuntimeIds: ["FIXTURE_CLI"],
                targetVersion: {
                    assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                },
                inputs: [
                    {
                        inputKind: "dialect_restoration" as const,
                        restoration: {
                            dialectId: "text",
                            restorationContractFingerprint: `sha256:${"9".repeat(64)}` as const,
                            contentHash: `sha256:${"a".repeat(64)}` as const,
                        },
                        content: { contentKind: "text" as const, text: "text" },
                    },
                ],
            },
        ];
        const dialectFingerprint = computeProviderRenderDialectInputFingerprint({
            adapterId: "A",
            adapterVersion: "1",
            dialectInputs,
        });
        expect(
            computeProviderRenderDialectInputFingerprint({
                adapterId: "A",
                adapterVersion: "1",
                dialectInputs: [...dialectInputs].reverse(),
            }),
        ).toBe(dialectFingerprint);
        for (const substituteAssetKind of [undefined, "Skill" as const]) {
            expect(
                computeProviderRenderDialectInputFingerprint({
                    adapterId: "A",
                    adapterVersion: "1",
                    dialectInputs: [
                        {
                            consumerAgentRuntimeIds: ["FIXTURE_CLI"],
                            targetVersion: {
                                assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                                versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                            },
                            inputs: [
                                {
                                    inputKind: "canonical_materialization",
                                    nativeDialectId: "fixture-native",
                                    materializer: {
                                        componentId: "fixture.canonical-materializer-v1",
                                        componentVersion: 1,
                                        configFingerprint: `sha256:${"b".repeat(64)}`,
                                    },
                                    degradationKinds: ["target_runtime_missing_asset_kind"],
                                    ...(substituteAssetKind === undefined ? {} : { substituteAssetKind }),
                                    reasonCode: "fixture_reviewed_migration",
                                },
                            ],
                        },
                    ],
                }),
            ).toMatch(/^sha256:/);
        }

        const renderRegistry = makeRenderRegistry();
        const deployment = makeRenderDeployment(renderRegistry);
        deployment.targetContexts[0]!.renderFacts.push({
            key: "alpha",
            value: "one",
            evidenceLevel: "agent_runtime_verified",
        });
        deployment.targetContexts.push({
            ...structuredClone(deployment.targetContexts[0]!),
            agentRuntimeId: "A_SECOND_RUNTIME",
        });
        deployment.assets.push(structuredClone(makeGuidanceRenderAsset()));
        deployment.assets[1]!.version.ref.assetId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        const { renderInputFingerprint: _oldInput, ...renderPreimage } = deployment;
        expect(computeRenderInputFingerprint(renderPreimage)).toMatch(/^sha256:/);
        expect(computeRenderInputFingerprint(renderPreimage)).not.toBe(
            computeRenderInputFingerprint({ ...renderPreimage, platformInstanceId: "other-instance" }),
        );

        const preserved = { outcome: "preserved" as const };
        const degraded = {
            outcome: "degraded" as const,
            degradationKinds: ["tool_permission_weakened" as const, "runtime_specific_metadata_lost" as const],
            degradationFingerprint: `sha256:${"b".repeat(64)}` as const,
        };
        const degradationFingerprint = computeRenderDegradationFingerprint({
            adapterId: "A",
            adapterVersion: "1",
            renderInputFingerprint: deployment.renderInputFingerprint,
            semanticRefFingerprint: `sha256:${"c".repeat(64)}`,
            renderStrategy: "inline",
            outcome: degraded,
            actualReverseExtractPolicy: "unsupported",
            reasonCode: "degraded",
        });
        const approvalFingerprint = computeRenderApprovalFingerprint({
            renderInputFingerprint: deployment.renderInputFingerprint,
            semanticRefFingerprint: `sha256:${"c".repeat(64)}`,
            renderStrategy: "inline",
            outcome: degraded,
            actualReverseExtractPolicy: "unsupported",
            concerns: ["reverse_extract_unsupported", "semantic_degradation"],
        });
        const option = {
            semanticRefFingerprint: `sha256:${"c".repeat(64)}` as const,
            renderStrategy: "inline" as const,
            actualReverseExtractPolicy: "unsupported" as const,
            approvalRequirement: {
                approvalState: "required" as const,
                concerns: ["reverse_extract_unsupported", "semantic_degradation"] as const,
                approvalFingerprint,
            },
            requiredOutputUnitFingerprints: [unitFingerprint, `sha256:${"d".repeat(64)}` as const],
            reasonCode: "degraded",
            ...degraded,
        };
        expect(degradationFingerprint).toMatch(/^sha256:/);
        expect(
            computeRenderOptionFingerprint({
                adapterId: "A",
                adapterVersion: "1",
                renderInputFingerprint: deployment.renderInputFingerprint,
                providerRenderDialectInputFingerprint: dialectFingerprint,
                option,
            }),
        ).toMatch(/^sha256:/);
        expect(
            computeRenderOptionFingerprint({
                adapterId: "A",
                adapterVersion: "1",
                renderInputFingerprint: deployment.renderInputFingerprint,
                providerRenderDialectInputFingerprint: dialectFingerprint,
                option: { ...option, substituteAssetKind: "Skill" },
            }),
        ).toMatch(/^sha256:/);
        expect(
            computeRenderApprovalFingerprint({
                renderInputFingerprint: deployment.renderInputFingerprint,
                semanticRefFingerprint: `sha256:${"e".repeat(64)}`,
                renderStrategy: "inline",
                outcome: preserved,
                actualReverseExtractPolicy: "can_reconcile",
                concerns: [],
            }),
        ).toMatch(/^sha256:/);

        const selection = {
            compilerPolicyVersion: "core_render_policy_v1" as const,
            renderInputFingerprint: deployment.renderInputFingerprint,
            semanticOptions: [
                { semanticRefFingerprint: `sha256:${"2".repeat(64)}` },
                { semanticRefFingerprint: `sha256:${"1".repeat(64)}` },
            ],
            outputUnits: [
                { outputUnitFingerprint: `sha256:${"2".repeat(64)}` },
                { outputUnitFingerprint: `sha256:${"1".repeat(64)}` },
            ],
            outputUnitRenderers: [
                { outputUnitFingerprint: `sha256:${"2".repeat(64)}` },
                { outputUnitFingerprint: `sha256:${"1".repeat(64)}` },
            ],
            promotionAuthorizations: [
                {
                    assetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    versionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                    target: {
                        targetKind: "project",
                        projectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                    },
                },
                {
                    assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    target: {
                        targetKind: "project",
                        projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                    },
                },
            ],
        };
        expect(computeRenderSelectionFingerprint(selection as never)).toMatch(/^sha256:/);
        expect(
            computeRenderObservationSelectionFingerprint({
                renderInputFingerprint: deployment.renderInputFingerprint,
                selection: {
                    schemaVersion: 1,
                    semanticOptions: selection.semanticOptions as never,
                    outputUnits: selection.outputUnits as never,
                    outputUnitRenderers: selection.outputUnitRenderers as never,
                },
            }),
        ).toMatch(/^sha256:/);
    });
});
