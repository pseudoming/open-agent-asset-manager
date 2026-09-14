/** Authority-focused split from the original oversized render test suite. */

import { describe, expect, it } from "vitest";
import type { RenderAnalysisInput } from "../../src/contracts/render";
import {
    createNativeProjectGuidanceProviderSupport,
    createVerifiedNativeProjectGuidanceBuild,
    findVerifiedNativeProjectGuidanceBuildForTest,
    makeVerifiedNativeProjectGuidanceTargetContextForTest,
    nativeProjectGuidanceRegistryComponents,
} from "../../src/render/native-project-guidance";
import {
    declarationAcceptsTargetKind,
    requireProfile,
    requireStaticTargetFacts,
} from "../../src/render/native-project-guidance-profiles";
import { createRenderRegistry } from "../../src/render/render-registry";
import { computeTargetApplicabilityFingerprint } from "../../src/foundation/fingerprint";
import { ASSET_ID, FILE_ID, VERSION_ID } from "../catalog/fixtures/version-v2";
import {
    ANTIGRAVITY_CLI_PROJECT_GUIDANCE_PROFILE,
    ANTIGRAVITY_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
    CLAUDE_CODE_CLI_PROJECT_GUIDANCE_PROFILE,
    CLAUDE_CODE_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
    HASH,
    makeFixture,
} from "./fixtures/native-project-guidance-test-fixtures";

describe("native project Guidance profiles and analysis", () => {
    it("registers each exact CLI project Guidance profile under its adapter-owned contract", () => {
        const claude = makeFixture("claude");
        const antigravity = makeFixture("antigravity");
        expect(claude.components.outputContracts[0]).toMatchObject({
            outputContractId: CLAUDE_CODE_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
            outputContractFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            materializationProfiles: [{ materializationProfileId: CLAUDE_CODE_CLI_PROJECT_GUIDANCE_PROFILE }],
        });
        expect(antigravity.components.outputContracts[0]).toMatchObject({
            outputContractId: ANTIGRAVITY_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
            outputContractFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            materializationProfiles: [{ materializationProfileId: ANTIGRAVITY_CLI_PROJECT_GUIDANCE_PROFILE }],
        });
        expect(claude.components.outputContracts[0]?.outputContractFingerprint).not.toBe(
            antigravity.components.outputContracts[0]?.outputContractFingerprint,
        );
        expect(Object.isFrozen(claude.support.renderContractDeclaration)).toBe(true);
        expect(claude.targetContext.renderFacts).toEqual([
            { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
        ]);
        expect(antigravity.targetContext.renderFacts).toEqual([
            {
                key: "oaam.platform",
                value: "wsl",
                evidenceLevel: "agent_runtime_verified",
            },
            {
                key: "oaam.project-binding",
                value: "registered",
                evidenceLevel: "agent_runtime_verified",
            },
        ]);
        claude.registry.validateTargetContext(claude.targetContext);
        antigravity.registry.validateTargetContext(antigravity.targetContext);
        expect(claude.components.consumerConformances).toHaveLength(1);
        expect(antigravity.components.consumerConformances).toHaveLength(1);
        expect(antigravity.build).not.toBeNull();
        const antigravityAnalysis = antigravity.support.analyze(antigravity.analysisInput);
        expect(
            antigravity.registry.findMaterializerCandidates(antigravityAnalysis.outputUnits[0]!, [
                {
                    context: antigravity.targetContext,
                    assetKind: "Guidance",
                    renderStrategy: "native_file",
                },
            ]),
        ).toEqual([
            expect.objectContaining({
                rendererAdapterId: "ANTIGRAVITY",
                materializationProfileId: ANTIGRAVITY_CLI_PROJECT_GUIDANCE_PROFILE,
            }),
        ]);
        expect(
            findVerifiedNativeProjectGuidanceBuildForTest({
                provider: claude.provider,
                agentRuntimeId: "CLAUDE_CODE_CLI",
                buildIdentity: `sha256:${"0".repeat(64)}`,
                platform: "wsl",
            }),
        ).toBeNull();
        expect(
            findVerifiedNativeProjectGuidanceBuildForTest({
                provider: claude.provider,
                agentRuntimeId: "CLAUDE_CODE_CLI",
                buildIdentity: claude.build.buildIdentity,
                platform: "linux",
            }),
        ).toBeNull();
    });

    it("admits a materializer only for the exact verified build and target facts", () => {
        const fixture = makeFixture("claude");
        const analysis = fixture.support.analyze(fixture.analysisInput);
        const unit = analysis.outputUnits[0]!;
        const requirement = {
            context: fixture.targetContext,
            assetKind: "Guidance" as const,
            renderStrategy: "native_file" as const,
        };
        expect(fixture.registry.findMaterializerCandidates(unit, [requirement])).toEqual([
            expect.objectContaining({
                rendererAdapterId: "CLAUDECODE",
                materializationProfileId: CLAUDE_CODE_CLI_PROJECT_GUIDANCE_PROFILE,
            }),
        ]);

        for (const mutate of [
            (context: typeof fixture.targetContext) => {
                context.versionText = "2.1.192";
            },
            (context: typeof fixture.targetContext) => {
                context.buildIdentity = `sha256:${"0".repeat(64)}`;
            },
            (context: typeof fixture.targetContext) => {
                context.renderFacts[0]!.value = "linux";
            },
            (context: typeof fixture.targetContext) => {
                context.renderFacts[0]!.evidenceLevel = "docs_declared";
            },
        ]) {
            const context = structuredClone(fixture.targetContext);
            mutate(context);
            context.targetApplicabilityFingerprint = computeTargetApplicabilityFingerprint({
                context: {
                    schemaVersion: context.schemaVersion,
                    agentRuntimeId: context.agentRuntimeId,
                    versionText: context.versionText,
                    buildIdentity: context.buildIdentity,
                    targetContextSchemaId: context.targetContextSchemaId,
                    targetContextSchemaFingerprint: context.targetContextSchemaFingerprint,
                    renderFacts: context.renderFacts,
                },
                entryClass: fixture.descriptor.entryClass,
            });
            expect(fixture.registry.findMaterializerCandidates(unit, [{ ...requirement, context }])).toEqual([]);
        }
    });

    it("admits a newer Guidance build only when the Provider declaration opts into compatibility", () => {
        const fixture = makeFixture("antigravity");
        const support = createNativeProjectGuidanceProviderSupport({
            adapterId: fixture.provider.adapterId,
            adapterVersion: fixture.provider.version,
            agentRuntimes: fixture.provider.agentRuntimes,
            agentRuntimeId: fixture.agentRuntimeId,
            outputContractId: ANTIGRAVITY_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
            materializationProfileId: ANTIGRAVITY_CLI_PROJECT_GUIDANCE_PROFILE,
            target: structuredClone(fixture.support.renderContractDeclaration.target),
            buildCompatibility: {
                schemaVersion: 1,
                versionOrdering: "numeric_dotted_core_v1",
                unknownVersionPolicy: "allow_with_warning",
                deniedBuilds: [],
            },
            verifiedBuilds: [fixture.build],
        });
        const provider = {
            ...fixture.provider,
            targetContextSchemas: [support.targetContextSchema],
            assetTargetCapabilities: [support.targetCapability],
            materializerCapabilities: [support.materializerCapability],
            renderContractDeclarations: [support.renderContractDeclaration],
        };
        const registry = createRenderRegistry({
            providers: [provider],
            ...nativeProjectGuidanceRegistryComponents([provider]),
        });
        const analysis = support.analyze(fixture.analysisInput);
        const outputUnit = analysis.outputUnits[0];
        if (outputUnit === undefined) throw new Error("compatible Guidance analysis produced no output unit");

        const current = makeVerifiedNativeProjectGuidanceTargetContextForTest({
            provider,
            build: fixture.build,
        });
        current.versionText = "1.1.10";
        current.buildIdentity = `sha256:${"7".repeat(64)}`;
        current.targetApplicabilityFingerprint = computeTargetApplicabilityFingerprint({
            context: {
                schemaVersion: current.schemaVersion,
                agentRuntimeId: current.agentRuntimeId,
                versionText: current.versionText,
                buildIdentity: current.buildIdentity,
                targetContextSchemaId: current.targetContextSchemaId,
                targetContextSchemaFingerprint: current.targetContextSchemaFingerprint,
                renderFacts: current.renderFacts,
            },
            entryClass: fixture.descriptor.entryClass,
        });

        expect(
            registry.findMaterializerCandidates(outputUnit, [
                { context: current, assetKind: "Guidance", renderStrategy: "native_file" },
            ]),
        ).toEqual([
            expect.objectContaining({
                rendererAdapterId: "ANTIGRAVITY",
                materializationProfileId: ANTIGRAVITY_CLI_PROJECT_GUIDANCE_PROFILE,
            }),
        ]);
    });

    it("selects one platform-specific conformance when two builds share the same consumer digest", () => {
        const fixture = makeFixture("claude");
        const linuxBuild = createVerifiedNativeProjectGuidanceBuild({
            agentRuntimeId: fixture.build.agentRuntimeId,
            versionText: fixture.build.versionText,
            buildIdentity: fixture.build.buildIdentity,
            platform: "linux",
            materializationProfileId: fixture.build.materializationProfileId,
            fixtureId: "claude-shared-consumer-linux-fixture",
            targetRelativePath: "CLAUDE.md",
            exactLoadMarker: "OAAM_SHARED_CONSUMER_LINUX",
            reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
        });
        const support = createNativeProjectGuidanceProviderSupport({
            adapterId: fixture.provider.adapterId,
            adapterVersion: fixture.provider.version,
            agentRuntimes: fixture.provider.agentRuntimes,
            agentRuntimeId: fixture.agentRuntimeId,
            outputContractId: CLAUDE_CODE_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
            materializationProfileId: CLAUDE_CODE_CLI_PROJECT_GUIDANCE_PROFILE,
            target: {
                relativePath: "CLAUDE.md",
                targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
                requiredFacts: { "fixture.channel": "stable", "fixture.mode": "exact" },
            },
            verifiedBuilds: [fixture.build, linuxBuild],
        });
        const provider = {
            ...fixture.provider,
            targetContextSchemas: [support.targetContextSchema],
            assetTargetCapabilities: [support.targetCapability],
            materializerCapabilities: [support.materializerCapability],
            renderContractDeclarations: [support.renderContractDeclaration],
        };
        const registry = createRenderRegistry({ providers: [provider], ...nativeProjectGuidanceRegistryComponents([provider]) });
        const wslContext = makeVerifiedNativeProjectGuidanceTargetContextForTest({ provider, build: fixture.build });
        const linuxContext = makeVerifiedNativeProjectGuidanceTargetContextForTest({ provider, build: linuxBuild });
        const analysisInput = structuredClone(fixture.analysisInput);
        analysisInput.deployment.targetContexts = [wslContext];
        const analysis = support.analyze(analysisInput);
        const outputUnit = analysis.outputUnits[0];
        if (outputUnit === undefined) throw new Error("shared-consumer Guidance analysis produced no output unit");

        registry.validateTargetContext(wslContext);
        registry.validateTargetContext(linuxContext);
        for (const context of [wslContext, linuxContext]) {
            expect(
                registry.findMaterializerCandidates(outputUnit, [
                    { context, assetKind: "Guidance", renderStrategy: "native_file" },
                ]),
            ).toEqual([
                expect.objectContaining({
                    rendererAdapterId: fixture.provider.adapterId,
                    materializationProfileId: CLAUDE_CODE_CLI_PROJECT_GUIDANCE_PROFILE,
                }),
            ]);
        }

        const unmatched = structuredClone(wslContext);
        unmatched.renderFacts[0]!.value = "darwin";
        unmatched.targetApplicabilityFingerprint = computeTargetApplicabilityFingerprint({
            context: {
                schemaVersion: unmatched.schemaVersion,
                agentRuntimeId: unmatched.agentRuntimeId,
                versionText: unmatched.versionText,
                buildIdentity: unmatched.buildIdentity,
                targetContextSchemaId: unmatched.targetContextSchemaId,
                targetContextSchemaFingerprint: unmatched.targetContextSchemaFingerprint,
                renderFacts: unmatched.renderFacts,
            },
            entryClass: fixture.descriptor.entryClass,
        });
        expect(
            registry.findMaterializerCandidates(outputUnit, [
                { context: unmatched, assetKind: "Guidance", renderStrategy: "native_file" },
            ]),
        ).toEqual([]);
    });

    it("fails construction and context creation when provider-owned declarations are inconsistent", () => {
        const fixture = makeFixture("claude");
        if (fixture.build === null) {
            throw new Error("verified Claude Code build fixture missing");
        }
        const build = fixture.build;
        expect(() => requireProfile(fixture.support.renderContractDeclaration, "foreign-profile-v1")).toThrow(
            /unknown native project Guidance profile/,
        );
        expect(() => requireStaticTargetFacts({ "oaam.target-kind": "unknown" })).toThrow(
            /oaam\.target-kind must name an explicit physical target kind/,
        );
        expect(declarationAcceptsTargetKind({ target: { requiredFacts: { "oaam.target-kind": "directory" } } }, "project")).toBe(
            false,
        );
        expect(declarationAcceptsTargetKind({ target: { requiredFacts: {} } }, "global")).toBe(true);
        expect(() =>
            createNativeProjectGuidanceProviderSupport({
                adapterId: "CLAUDECODE",
                adapterVersion: "0.4.0",
                agentRuntimes: [fixture.descriptor],
                agentRuntimeId: "CLAUDE_CODE_CLI",
                outputContractId: CLAUDE_CODE_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
                materializationProfileId: CLAUDE_CODE_CLI_PROJECT_GUIDANCE_PROFILE,
                target: {
                    relativePath: "CLAUDE.md",
                    targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
                    requiredFacts: { "oaam.platform": "wsl" },
                },
                verifiedBuilds: [build],
            }),
        ).toThrow(/oaam\.platform is build-bound/);
        expect(() =>
            createNativeProjectGuidanceProviderSupport({
                adapterId: "CLAUDECODE",
                adapterVersion: "0.3.0",
                agentRuntimes: [fixture.descriptor],
                agentRuntimeId: "CLAUDE_CODE_CLI",
                outputContractId: CLAUDE_CODE_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
                materializationProfileId: CLAUDE_CODE_CLI_PROJECT_GUIDANCE_PROFILE,
                target: {
                    relativePath: "CLAUDE.md",
                    targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
                    requiredFacts: {},
                },
                verifiedBuilds: [],
            }),
        ).toThrow(/verified builds/);
        expect(() =>
            createNativeProjectGuidanceProviderSupport({
                adapterId: "CLAUDECODE",
                adapterVersion: "0.3.0",
                agentRuntimes: [fixture.descriptor],
                agentRuntimeId: "CLAUDE_CODE_CLI",
                outputContractId: CLAUDE_CODE_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
                materializationProfileId: CLAUDE_CODE_CLI_PROJECT_GUIDANCE_PROFILE,
                target: {
                    relativePath: "CLAUDE.md",
                    targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
                    requiredFacts: {},
                },
                verifiedBuilds: [{ ...build, agentRuntimeId: "FOREIGN_CLI" }],
            }),
        ).toThrow(/verified builds/);
        expect(() =>
            createNativeProjectGuidanceProviderSupport({
                adapterId: "CLAUDECODE",
                adapterVersion: "0.3.0",
                agentRuntimes: [],
                agentRuntimeId: "CLAUDE_CODE_CLI",
                outputContractId: CLAUDE_CODE_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
                materializationProfileId: CLAUDE_CODE_CLI_PROJECT_GUIDANCE_PROFILE,
                target: {
                    relativePath: "CLAUDE.md",
                    targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
                    requiredFacts: {},
                },
                verifiedBuilds: [build],
            }),
        ).toThrow(/unknown agent runtime/);
        expect(() =>
            createNativeProjectGuidanceProviderSupport({
                adapterId: "CLAUDECODE",
                adapterVersion: "0.3.0",
                agentRuntimes: [fixture.descriptor],
                agentRuntimeId: "CLAUDE_CODE_CLI",
                outputContractId: CLAUDE_CODE_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
                materializationProfileId: CLAUDE_CODE_CLI_PROJECT_GUIDANCE_PROFILE,
                target: {
                    relativePath: "AGENTS.md",
                    targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
                    requiredFacts: {},
                },
                verifiedBuilds: [{ ...build, materializationProfileId: "foreign-profile" }],
            }),
        ).toThrow(/verified builds/);
        const noSchema = structuredClone(fixture.provider);
        noSchema.targetContextSchemas = [];
        expect(() =>
            makeVerifiedNativeProjectGuidanceTargetContextForTest({
                provider: noSchema,
                build,
            }),
        ).toThrow(/no provider target schema/);
        const noDescriptor = structuredClone(fixture.provider);
        noDescriptor.agentRuntimes = [];
        expect(() =>
            makeVerifiedNativeProjectGuidanceTargetContextForTest({
                provider: noDescriptor,
                build,
            }),
        ).toThrow(/no provider target schema/);
        expect(() => nativeProjectGuidanceRegistryComponents([noSchema])).toThrow(/conformance has no provider schema/);
        expect(() =>
            makeVerifiedNativeProjectGuidanceTargetContextForTest({
                provider: fixture.provider,
                build: { ...build, versionText: "forged" },
            }),
        ).toThrow(/registered verified build/);
        expect(nativeProjectGuidanceRegistryComponents([]).consumerConformances).toEqual([]);
    });

    it("analyzes one exact project Guidance asset and blocks unsupported semantics separately", () => {
        for (const kind of ["claude", "antigravity"] as const) {
            const fixture = makeFixture(kind);
            const result = fixture.support.analyze(fixture.analysisInput);
            expect(result).toMatchObject({
                status: "complete",
                outputUnits: [
                    expect.objectContaining({
                        claims: [
                            expect.objectContaining({
                                relativePath: kind === "claude" ? "CLAUDE.md" : "AGENTS.md",
                            }),
                        ],
                    }),
                ],
                blockedSemanticRefs: [],
            });
            expect(result.semanticOptions).toHaveLength(3);

            const mixed = structuredClone(fixture.analysisInput);
            mixed.requiredSemantics.push({
                ...structuredClone(mixed.requiredSemantics[0]!),
                semanticRefFingerprint: HASH,
                consumerAgentRuntimeId: "FOREIGN",
            });
            const partial = fixture.support.analyze(mixed);
            expect(partial.status).toBe("partial");
            expect(partial.semanticOptions).toHaveLength(3);
            expect(partial.blockedSemanticRefs).toEqual([expect.objectContaining({ semanticRefFingerprint: HASH })]);
        }
    });

    it("rejects malformed project Guidance asset shapes without producing an output unit", () => {
        const fixture = makeFixture("claude");
        const mutations: Array<(input: RenderAnalysisInput) => void> = [
            (input) => {
                input.deployment.assets = [];
            },
            (input) => {
                input.deployment.assets.push(structuredClone(input.deployment.assets[0]!));
            },
            (input) => {
                input.deployment.assets[0]!.scope = "global";
            },
            (input) => {
                input.deployment.assets[0]!.projectId = "";
            },
            (input) => {
                input.deployment.assets[0]!.scopePath = "nested";
            },
            (input) => {
                input.deployment.assets[0]!.version.status = "incomplete";
            },
            (input) => {
                input.deployment.assets[0]!.version.canonical = {
                    kind: "Rule",
                    typeData: {
                        schemaVersion: 2,
                        name: "r",
                        description: "d",
                        activation: { mode: "always" },
                    },
                };
            },
            (input) => {
                input.deployment.assets[0]!.version.files.push(structuredClone(input.deployment.assets[0]!.version.files[0]!));
            },
            (input) => {
                input.deployment.assets[0]!.version.files[0]!.file.role = "resource";
            },
            (input) => {
                input.deployment.assets[0]!.version.files[0]!.file.executable = true;
            },
            (input) => {
                input.deployment.assets[0]!.version.files[0]!.file.references.push({
                    kind: "link",
                    rawTarget: "other.md",
                    required: false,
                    diagnostics: [],
                    resolution: "unresolved",
                });
            },
            (input) => {
                const file = input.deployment.assets[0]!.version.files[0]!;
                if (file.contentKind === "text") file.text = "";
            },
            (input) => {
                const file = input.deployment.assets[0]!.version.files[0]!;
                if (file.contentKind === "text") file.text = "# bad\r\n";
            },
            (input) => {
                input.deployment.targetContexts[0]!.targetContextSchemaId = "wrong";
            },
            (input) => {
                input.deployment.targetContexts.push(structuredClone(input.deployment.targetContexts[0]!));
            },
            (input) => {
                input.dialectInputs.push({
                    targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
                    inputs: [],
                });
            },
            (input) => {
                input.requiredSemantics.pop();
            },
            (input) => {
                const semantic = input.requiredSemantics.find((item) => item.semanticKind === "guidance.base_context")!;
                semantic.subject = {
                    subjectKind: "file",
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    fileId: FILE_ID,
                };
            },
        ];
        for (const mutate of mutations) {
            const input = structuredClone(fixture.analysisInput);
            mutate(input);
            expect(fixture.support.analyze(input)).toMatchObject({
                status: "failed",
                outputUnits: [],
                semanticOptions: [],
            });
        }
    });
});
