/** Authority-focused split from the original oversized render test suite. */

import { describe, expect, it } from "vitest";
import { binaryPayloadStats, textPayloadStats } from "../../src/catalog/payload-store";
import type { RenderOutputUnit } from "../../src/contracts/deployment-authority";
import type { AdapterRenderAnalysisResult, RenderAnalysisInput } from "../../src/contracts/render";
import {
    computeRenderOutputUnitFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../../src/foundation/fingerprint";
import { validateAdapterRenderAnalysisResult } from "../../src/render/render-analysis";
import { validateNativeRepresentationInput, validateOutputUnit } from "../../src/render/render-analysis-validator";
import { diagnosticCode, validAnalysisFixture } from "./fixtures/render-analysis-test-fixtures";
import { makeAnalysisResult, makeOutputUnit } from "./fixtures/render-contract-fixtures";

describe("provider render analysis validation", () => {
    it("accepts one exact V2 directory output graph and rejects every malformed member class", () => {
        const preimage = {
            outputContractId: "fixture-directory-v2",
            outputContractFingerprint: `sha256:${"1".repeat(64)}` as const,
            claims: [{ relativePath: "tree/file.md" as const, contentKind: "text" as const, executable: false }],
            managedDirectoryBoundaries: [
                {
                    schemaVersion: 2 as const,
                    relativePath: "tree" as const,
                    boundaryKind: "directory_inventory" as const,
                    desiredDirectoryPaths: ["tree", "tree/empty"] as const,
                },
            ],
        };
        const unit: RenderOutputUnit = {
            ...preimage,
            outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage),
        };
        expect(() => validateOutputUnit(unit)).not.toThrow();
        for (const desiredDirectoryPaths of [
            [],
            ["tree/empty"],
            ["tree", "../unsafe"],
            ["tree", "other"],
            ["tree", "tree/file.md"],
            ["tree", "tree/z", "tree/a"],
            ["tree", "tree/empty", "tree/empty"],
        ]) {
            const invalid = structuredClone(unit);
            const boundary = invalid.managedDirectoryBoundaries[0];
            if (boundary === undefined || !("desiredDirectoryPaths" in boundary)) throw new Error("missing V2 boundary");
            boundary.desiredDirectoryPaths = desiredDirectoryPaths as never;
            expect(() => validateOutputUnit(invalid)).toThrow();
        }
    });

    it("rejects a forged provider status or non-array result collection", async () => {
        const fixture = await validAnalysisFixture();
        const cases: Array<(value: AdapterRenderAnalysisResult) => void> = [
            (value) => {
                value.status = "unknown" as never;
            },
            (value) => {
                value.outputUnits = null as never;
            },
            (value) => {
                value.semanticOptions = null as never;
            },
            (value) => {
                value.blockedSemanticRefs = null as never;
            },
            (value) => {
                value.diagnostics = null as never;
            },
        ];
        for (const mutate of cases) {
            const value = structuredClone(fixture.result);
            mutate(value);
            expect(diagnosticCode(fixture.provider, fixture.input, value)).toBe("render.provider_result_shape_invalid");
        }
    });

    it("rejects foreign or incomplete provider input projections before trusting output", async () => {
        const fixture = await validAnalysisFixture();
        const cases: Array<[string, (input: RenderAnalysisInput) => void]> = [
            [
                "render.provider_input_schema",
                (input) => {
                    input.schemaVersion = 2 as never;
                },
            ],
            [
                "render.provider_input_foreign_context",
                (input) => {
                    input.deployment.targetContexts[0]!.agentRuntimeId = "FOREIGN" as never;
                },
            ],
            [
                "render.provider_input_foreign_semantic",
                (input) => {
                    input.requiredSemantics[0]!.consumerAgentRuntimeId = "FOREIGN" as never;
                },
            ],
            [
                "render.provider_input_context_missing",
                (input) => {
                    input.deployment.targetContexts = [];
                },
            ],
            [
                "render.semantic_asset_missing",
                (input) => {
                    input.requiredSemantics[0]!.subject.assetId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
                },
            ],
        ];
        for (const [code, mutate] of cases) {
            const input = structuredClone(fixture.input);
            mutate(input);
            expect(diagnosticCode(fixture.provider, input, fixture.result)).toBe(code);
        }
    });

    it("accepts a complete provider-owned result and rejects semantic closure lies", async () => {
        const fixture = await validAnalysisFixture();
        expect(validateAdapterRenderAnalysisResult(fixture.provider, fixture.input, fixture.result)).toEqual([]);
        const cases: Array<[string, (value: AdapterRenderAnalysisResult) => void]> = [
            [
                "render.option_foreign_semantic",
                (value) => {
                    value.semanticOptions[0]!.semanticRefFingerprint = `sha256:${"9".repeat(64)}`;
                },
            ],
            [
                "render.option_duplicate",
                (value) => {
                    value.semanticOptions.push(structuredClone(value.semanticOptions[0]!));
                },
            ],
            [
                "render.blocked_ref_invalid",
                (value) => {
                    value.blockedSemanticRefs = [
                        {
                            semanticRefFingerprint: `sha256:${"8".repeat(64)}`,
                            reasonCode: "blocked",
                            diagnostics: [],
                        },
                    ];
                },
            ],
            [
                "render.blocked_reason_missing",
                (value) => {
                    const option = value.semanticOptions.pop()!;
                    value.blockedSemanticRefs = [
                        {
                            semanticRefFingerprint: option.semanticRefFingerprint,
                            reasonCode: " ",
                            diagnostics: [],
                        },
                    ];
                },
            ],
            [
                "render.semantic_closure_invalid",
                (value) => {
                    value.semanticOptions.pop();
                },
            ],
            [
                "render.output_unit_closure_invalid",
                (value) => {
                    value.outputUnits.push(makeOutputUnit(fixture.contract, "unused.md"));
                },
            ],
            [
                "render.output_unit_duplicate",
                (value) => {
                    value.outputUnits.push(structuredClone(value.outputUnits[0]!));
                },
            ],
            [
                "render.option_unit_missing",
                (value) => {
                    value.semanticOptions[0]!.requiredOutputUnitFingerprints = [`sha256:${"7".repeat(64)}`];
                },
            ],
            [
                "render.noncanonical_set",
                (value) => {
                    value.semanticOptions[0]!.requiredOutputUnitFingerprints.push(
                        value.semanticOptions[0]!.requiredOutputUnitFingerprints[0]!,
                    );
                },
            ],
        ];
        for (const [code, mutate] of cases) {
            const value = structuredClone(fixture.result);
            mutate(value);
            expect(diagnosticCode(fixture.provider, fixture.input, value)).toBe(code);
        }

        const duplicateSemantics = structuredClone(fixture.input);
        duplicateSemantics.requiredSemantics.push(structuredClone(duplicateSemantics.requiredSemantics[0]!));
        expect(diagnosticCode(fixture.provider, duplicateSemantics, fixture.result)).toBe("render.semantic_input_invalid");
    });

    it("rejects malformed output-unit paths, boundaries, and fingerprints", async () => {
        const fixture = await validAnalysisFixture();
        const cases: Array<[string, (unit: RenderOutputUnit) => void]> = [
            [
                "render.output_claim_missing",
                (unit) => {
                    unit.claims = [];
                },
            ],
            [
                "render.noncanonical_set",
                (unit) => {
                    unit.claims = [unit.claims[0]!, { ...unit.claims[0]! }];
                },
            ],
            [
                "render.output_claim_invalid",
                (unit) => {
                    unit.claims[0]!.relativePath = "../escape";
                },
            ],
            [
                "render.output_claim_invalid",
                (unit) => {
                    unit.claims[0]!.contentKind = "other" as never;
                },
            ],
            [
                "render.output_claim_invalid",
                (unit) => {
                    unit.claims[0]!.executable = "yes" as never;
                },
            ],
            [
                "render.output_claim_prefix_conflict",
                (unit) => {
                    unit.claims = [unit.claims[0]!, { ...unit.claims[0]!, relativePath: "AGENTS.md/child" }];
                },
            ],
            [
                "render.output_boundary_invalid",
                (unit) => {
                    unit.managedDirectoryBoundaries = [{ relativePath: "../bad", boundaryKind: "directory_inventory" }];
                },
            ],
            [
                "render.output_boundary_invalid",
                (unit) => {
                    unit.managedDirectoryBoundaries = [{ relativePath: "managed", boundaryKind: "other" as never }];
                },
            ],
            [
                "render.output_boundary_claim_invalid",
                (unit) => {
                    unit.managedDirectoryBoundaries = [
                        {
                            relativePath: "AGENTS.md/dir",
                            boundaryKind: "directory_inventory",
                        },
                    ];
                },
            ],
            [
                "render.output_unit_fingerprint_mismatch",
                (unit) => {
                    unit.outputUnitFingerprint = `sha256:${"6".repeat(64)}`;
                },
            ],
        ];
        for (const [code, mutate] of cases) {
            const value = structuredClone(fixture.result);
            mutate(value.outputUnits[0]!);
            expect(diagnosticCode(fixture.provider, fixture.input, value)).toBe(code);
        }
        const validBoundary = structuredClone(fixture.result);
        validBoundary.outputUnits[0]!.managedDirectoryBoundaries = [
            { relativePath: "managed", boundaryKind: "directory_inventory" },
        ];
        const { outputUnitFingerprint: _old, ...preimage } = validBoundary.outputUnits[0]!;
        const newFingerprint = computeRenderOutputUnitFingerprint(preimage);
        validBoundary.outputUnits[0]!.outputUnitFingerprint = newFingerprint;
        for (const option of validBoundary.semanticOptions) {
            option.requiredOutputUnitFingerprints = [newFingerprint];
        }
        expect(diagnosticCode(fixture.provider, fixture.input, validBoundary)).toBe("render.option_fingerprint_mismatch");
    });

    it("rejects unsupported strategy/reverse policy and exact degradation or approval tampering", async () => {
        const fixture = await validAnalysisFixture();
        const degraded = makeAnalysisResult(fixture.provider, fixture.input, fixture.contract, {
            outcome: "degraded",
            reversePolicy: "unsupported",
        });
        expect(diagnosticCode(fixture.provider, fixture.input, degraded)).toBe("render.option_reverse_policy_invalid");

        const cases: Array<[string, (value: AdapterRenderAnalysisResult) => void]> = [
            [
                "render.outcome_invalid",
                (value) => {
                    value.semanticOptions[0]!.outcome = "unknown" as never;
                },
            ],
            [
                "render.reverse_policy_invalid",
                (value) => {
                    value.semanticOptions[0]!.actualReverseExtractPolicy = "unknown" as never;
                },
            ],
            [
                "render.option_capability_missing",
                (value) => {
                    value.semanticOptions[0]!.renderStrategy = "native_import";
                },
            ],
            [
                "render.option_shape_invalid",
                (value) => {
                    value.semanticOptions[0]!.reasonCode = "";
                },
            ],
            [
                "render.approval_overclaimed",
                (value) => {
                    value.semanticOptions[0]!.approvalRequirement = {
                        approvalState: "required",
                        concerns: ["semantic_degradation"],
                        approvalFingerprint: `sha256:${"1".repeat(64)}`,
                    };
                },
            ],
            [
                "render.option_fingerprint_mismatch",
                (value) => {
                    value.semanticOptions[0]!.optionFingerprint = `sha256:${"2".repeat(64)}`;
                },
            ],
        ];
        for (const [code, mutate] of cases) {
            const value = structuredClone(fixture.result);
            mutate(value);
            expect(diagnosticCode(fixture.provider, fixture.input, value)).toBe(code);
        }

        const flexibleProvider = structuredClone(fixture.provider);
        const capability = flexibleProvider.assetTargetCapabilities.find((item) => "reverseExtractPolicy" in item);
        if (capability !== undefined && "reverseExtractPolicy" in capability) {
            capability.reverseExtractPolicy = "requires_user_choice";
        }
        const preservedUnsupported = makeAnalysisResult(flexibleProvider, fixture.input, fixture.contract, {
            reversePolicy: "unsupported",
        });
        expect(diagnosticCode(flexibleProvider, fixture.input, preservedUnsupported)).toBeUndefined();

        const degradedValid = makeAnalysisResult(flexibleProvider, fixture.input, fixture.contract, {
            outcome: "degraded",
            reversePolicy: "unsupported",
        });
        expect(diagnosticCode(flexibleProvider, fixture.input, degradedValid)).toBeUndefined();
        const preservedSubstitute = structuredClone(fixture.result);
        preservedSubstitute.semanticOptions[0]!.substituteAssetKind = "Skill";
        expect(diagnosticCode(flexibleProvider, fixture.input, preservedSubstitute)).toBe("render.substitute_kind_invalid");
        const degradationCases: Array<[string, (value: AdapterRenderAnalysisResult) => void]> = [
            [
                "render.substitute_kind_invalid",
                (value) => {
                    value.semanticOptions[0]!.substituteAssetKind = "Skill";
                },
            ],
            [
                "render.degradation_empty",
                (value) => {
                    if (value.semanticOptions[0]!.outcome === "degraded") value.semanticOptions[0]!.degradationKinds = [];
                },
            ],
            [
                "render.degradation_kind_invalid",
                (value) => {
                    if (value.semanticOptions[0]!.outcome === "degraded")
                        value.semanticOptions[0]!.degradationKinds = ["unknown" as never];
                },
            ],
            [
                "render.degradation_fingerprint_mismatch",
                (value) => {
                    if (value.semanticOptions[0]!.outcome === "degraded")
                        value.semanticOptions[0]!.degradationFingerprint = `sha256:${"4".repeat(64)}`;
                },
            ],
            [
                "render.approval_concerns_invalid",
                (value) => {
                    value.semanticOptions[0]!.approvalRequirement = {
                        approvalState: "not_required",
                    };
                },
            ],
            [
                "render.approval_fingerprint_mismatch",
                (value) => {
                    const approval = value.semanticOptions[0]!.approvalRequirement;
                    if (approval.approvalState === "required") approval.approvalFingerprint = `sha256:${"5".repeat(64)}`;
                },
            ],
        ];
        for (const [code, mutate] of degradationCases) {
            const value = structuredClone(degradedValid);
            mutate(value);
            expect(diagnosticCode(flexibleProvider, fixture.input, value)).toBe(code);
        }
    });

    it("validates native/restoration dialect bytes and rejects every projection mismatch", async () => {
        const fixture = await validAnalysisFixture();
        const asset = fixture.input.deployment.assets[0]!;
        const canonicalFingerprint = asset.version.versionCanonicalContentFingerprint;
        const text = "# Native\n";
        const textStats = textPayloadStats(text);
        const nativeFiles = [
            {
                relativePath: "native.md",
                contentKind: "text" as const,
                mediaType: "text/markdown",
                contentHash: textStats.contentHash,
                byteSize: textStats.byteSize,
                executable: false,
                text,
            },
        ];
        const nativeBase = {
            schemaVersion: 1 as const,
            dialectId: "fixture-native",
            dialectContractFingerprint: `sha256:${"1".repeat(64)}` as const,
            canonicalContentFingerprint: canonicalFingerprint,
        };
        const native = {
            inputKind: "native_representation" as const,
            inputRole: "current_exact" as const,
            representation: {
                ...nativeBase,
                representationFingerprint: computeVersionNativeRepresentationFingerprint({
                    ...nativeBase,
                    files: nativeFiles.map(({ text: _text, ...file }) => file),
                }),
            },
            files: nativeFiles,
        };
        const restoreText = "restoration";
        const restoration = {
            inputKind: "dialect_restoration" as const,
            restoration: {
                dialectId: "fixture-restore",
                restorationContractFingerprint: `sha256:${"2".repeat(64)}` as const,
                contentHash: textPayloadStats(restoreText).contentHash,
            },
            content: { contentKind: "text" as const, text: restoreText },
        };
        const validInput = structuredClone(fixture.input);
        validInput.dialectInputs = [
            {
                targetVersion: asset.version.ref,
                consumerAgentRuntimeIds: [fixture.input.requiredSemantics[0]!.consumerAgentRuntimeId],
                inputs: [native, restoration],
            },
        ];
        const validResult = makeAnalysisResult(fixture.provider, validInput, fixture.contract);
        expect(diagnosticCode(fixture.provider, validInput, validResult)).toBeUndefined();

        const v2Native = structuredClone(native);
        v2Native.files[0]!.relativePath = "bundle/native.md";
        const v2Preimage = {
            schemaVersion: 2 as const,
            dialectId: v2Native.representation.dialectId,
            dialectContractFingerprint: v2Native.representation.dialectContractFingerprint,
            canonicalContentFingerprint: v2Native.representation.canonicalContentFingerprint,
            directories: ["bundle"],
            files: v2Native.files.map(({ text: _text, ...file }) => file),
        };
        v2Native.representation = {
            ...v2Preimage,
            representationFingerprint: computeVersionNativeRepresentationFingerprint(v2Preimage),
        };
        expect(() => validateNativeRepresentationInput(v2Native, canonicalFingerprint)).not.toThrow();
        for (const directories of [[], ["missing"], ["bundle/child"], ["bundle", "bundle/native.md"]]) {
            const invalid = structuredClone(v2Native);
            if (invalid.representation.schemaVersion !== 2) throw new Error("missing V2 native fixture");
            invalid.representation.directories = directories as never;
            expect(() => validateNativeRepresentationInput(invalid, canonicalFingerprint)).toThrow();
        }

        const invalidCases: Array<[string, (input: RenderAnalysisInput) => void]> = [
            [
                "render.dialect_projection_invalid",
                (input) => {
                    input.dialectInputs[0]!.targetVersion.versionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
                },
            ],
            [
                "render.dialect_consumer_scope_invalid",
                (input) => {
                    input.dialectInputs.push(structuredClone(input.dialectInputs[0]!));
                },
            ],
            [
                "render.dialect_projection_invalid",
                (input) => {
                    input.dialectInputs[0]!.inputs = [];
                },
            ],
            [
                "render.dialect_input_duplicate",
                (input) => {
                    input.dialectInputs[0]!.inputs.push(structuredClone(input.dialectInputs[0]!.inputs[0]!));
                },
            ],
            [
                "render.native_representation_invalid",
                (input) => {
                    const item = input.dialectInputs[0]!.inputs[0]!;
                    if (item.inputKind === "native_representation") item.representation.dialectId = " ";
                },
            ],
            [
                "render.native_representation_invalid",
                (input) => {
                    const item = input.dialectInputs[0]!.inputs[0]!;
                    if (item.inputKind === "native_representation") {
                        (item.representation as { schemaVersion: number }).schemaVersion = 3;
                    }
                },
            ],
            [
                "render.noncanonical_set",
                (input) => {
                    const item = input.dialectInputs[0]!.inputs[0]!;
                    if (item.inputKind === "native_representation") item.files.push(structuredClone(item.files[0]!));
                },
            ],
            [
                "render.native_file_invalid",
                (input) => {
                    const item = input.dialectInputs[0]!.inputs[0]!;
                    if (item.inputKind === "native_representation") item.files[0]!.relativePath = "../bad";
                },
            ],
            [
                "render.native_file_payload_mismatch",
                (input) => {
                    const item = input.dialectInputs[0]!.inputs[0]!;
                    if (item.inputKind === "native_representation" && item.files[0]!.contentKind === "text")
                        item.files[0]!.text = "changed";
                },
            ],
            [
                "render.native_representation_fingerprint_mismatch",
                (input) => {
                    const item = input.dialectInputs[0]!.inputs[0]!;
                    if (item.inputKind === "native_representation")
                        item.representation.representationFingerprint = `sha256:${"3".repeat(64)}`;
                },
            ],
            [
                "render.restoration_payload_mismatch",
                (input) => {
                    const item = input.dialectInputs[0]!.inputs[1]!;
                    if (item.inputKind === "dialect_restoration") item.restoration.contentHash = `sha256:${"4".repeat(64)}`;
                },
            ],
        ];
        for (const [code, mutate] of invalidCases) {
            const input = structuredClone(validInput);
            mutate(input);
            expect(diagnosticCode(fixture.provider, input, validResult)).toBe(code);
        }

        const binaryBytes = Uint8Array.of(9, 8);
        const binaryStats = binaryPayloadStats(binaryBytes);
        const binaryNativeBase = {
            schemaVersion: 1 as const,
            dialectId: "fixture-native-binary",
            dialectContractFingerprint: `sha256:${"6".repeat(64)}` as const,
            canonicalContentFingerprint: `sha256:${"9".repeat(64)}` as const,
        };
        const binaryNativeFiles = [
            {
                relativePath: "native.bin",
                contentKind: "binary" as const,
                mediaType: "application/octet-stream",
                contentHash: binaryStats.contentHash,
                byteSize: binaryStats.byteSize,
                executable: false,
                bytes: binaryBytes,
            },
        ];
        const binaryInput = structuredClone(fixture.input);
        binaryInput.dialectInputs = [
            {
                targetVersion: asset.version.ref,
                consumerAgentRuntimeIds: [fixture.input.requiredSemantics[0]!.consumerAgentRuntimeId],
                inputs: [
                    {
                        inputKind: "dialect_restoration",
                        restoration: {
                            dialectId: "binary-restore",
                            restorationContractFingerprint: `sha256:${"5".repeat(64)}`,
                            contentHash: binaryStats.contentHash,
                        },
                        content: { contentKind: "binary", bytes: binaryBytes },
                    },
                    {
                        inputKind: "native_representation",
                        inputRole: "parent_rebase_seed",
                        sourceVersion: {
                            assetId: asset.version.ref.assetId,
                            versionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                        },
                        representation: {
                            ...binaryNativeBase,
                            representationFingerprint: computeVersionNativeRepresentationFingerprint({
                                ...binaryNativeBase,
                                files: binaryNativeFiles.map(({ bytes: _bytes, ...file }) => file),
                            }),
                        },
                        files: binaryNativeFiles,
                    },
                ],
            },
        ];
        expect(
            diagnosticCode(fixture.provider, binaryInput, makeAnalysisResult(fixture.provider, binaryInput, fixture.contract)),
        ).toBeUndefined();

        for (const sourceVersion of [
            asset.version.ref,
            { assetId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", versionId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
        ]) {
            const rejected = structuredClone(binaryInput);
            const parent = rejected.dialectInputs[0]!.inputs[1]!;
            if (parent.inputKind === "native_representation" && parent.inputRole === "parent_rebase_seed") {
                parent.sourceVersion = sourceVersion;
            }
            expect(
                diagnosticCode(fixture.provider, rejected, makeAnalysisResult(fixture.provider, rejected, fixture.contract)),
            ).toBe("render.parent_native_source_invalid");
        }

        const canonicalInput = structuredClone(fixture.input);
        canonicalInput.dialectInputs = [
            {
                targetVersion: asset.version.ref,
                consumerAgentRuntimeIds: [fixture.input.requiredSemantics[0]!.consumerAgentRuntimeId],
                inputs: [
                    {
                        inputKind: "canonical_materialization",
                        nativeDialectId: "fixture-native",
                        materializer: {
                            componentId: "fixture.canonical-materializer-v1",
                            componentVersion: 1,
                            configFingerprint: `sha256:${"7".repeat(64)}`,
                        },
                        degradationKinds: ["target_runtime_missing_asset_kind"],
                        reasonCode: "fixture_reviewed_migration",
                    },
                ],
            },
        ];
        expect(
            diagnosticCode(
                fixture.provider,
                canonicalInput,
                makeAnalysisResult(fixture.provider, canonicalInput, fixture.contract),
            ),
        ).toBeUndefined();
        const losslessInput = structuredClone(canonicalInput);
        const losslessToken = losslessInput.dialectInputs[0]!.inputs[0]!;
        if (losslessToken.inputKind !== "canonical_materialization") throw new Error("Expected canonical token");
        losslessToken.degradationKinds = [];
        expect(
            diagnosticCode(
                fixture.provider,
                losslessInput,
                makeAnalysisResult(fixture.provider, losslessInput, fixture.contract),
            ),
        ).toBeUndefined();
        for (const mutate of [
            (input: RenderAnalysisInput) => {
                const item = input.dialectInputs[0]!.inputs[0]!;
                if (item.inputKind === "canonical_materialization") item.nativeDialectId = " padded ";
            },
            (input: RenderAnalysisInput) => {
                const item = input.dialectInputs[0]!.inputs[0]!;
                if (item.inputKind === "canonical_materialization") {
                    item.degradationKinds = ["target_runtime_missing_asset_kind", "target_runtime_missing_asset_kind"];
                }
            },
            (input: RenderAnalysisInput) => {
                const item = input.dialectInputs[0]!.inputs[0]!;
                if (item.inputKind === "canonical_materialization") {
                    item.degradationKinds = ["workflow_variable_lost", "target_runtime_missing_asset_kind"];
                }
            },
        ]) {
            const rejected = structuredClone(canonicalInput);
            mutate(rejected);
            expect(
                diagnosticCode(fixture.provider, rejected, makeAnalysisResult(fixture.provider, rejected, fixture.contract)),
            ).toBe("render.canonical_materialization_authority_invalid");
        }
    });

    it("requires a missing-entry semantic to be blocked, not dressed up as an option", async () => {
        const fixture = await validAnalysisFixture();
        const input = structuredClone(fixture.input);
        const missing = structuredClone(input.requiredSemantics[0]!);
        missing.subject = {
            subjectKind: "missing_required_file_role",
            assetId: missing.subject.assetId,
            versionId: missing.subject.versionId,
            fileRole: "entry",
        };
        input.requiredSemantics = [missing];
        const value = makeAnalysisResult(fixture.provider, input, fixture.contract);
        expect(diagnosticCode(fixture.provider, input, value)).toBe("render.missing_entry_not_blocked");
        value.semanticOptions = [];
        value.outputUnits = [];
        value.blockedSemanticRefs = [
            {
                semanticRefFingerprint: missing.semanticRefFingerprint,
                reasonCode: "missing_entry",
                diagnostics: [],
            },
        ];
        expect(diagnosticCode(fixture.provider, input, value)).toBeUndefined();
    });
});
