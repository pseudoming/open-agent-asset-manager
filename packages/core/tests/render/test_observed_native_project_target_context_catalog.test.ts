import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterProviderSummary, ProbeResult } from "../../src/contracts/source-import";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import {
    createNativeGlobalGuidanceProviderSupport,
    createNativeProjectGuidanceProviderSupport,
    createVerifiedNativeGlobalGuidanceBuild,
    type ResolveObservedNativeProjectGuidanceTargetContextInput,
    resolveObservedNativeProjectGuidanceTargetContext,
    resolveObservedNativeProjectTargetContext,
    type VerifiedNativeProjectGuidanceBuild,
} from "../../src/render/native-project-guidance";
import { resolveObservedNativeProjectTargetContextAsyncWithSnapshot } from "../../src/render/native-project-guidance-observation";
import { resolveReadyObservedTargetCandidate } from "../../src/render/native-project-target-authority";
import { createTargetCheckObservationSnapshot } from "../../src/render/native-project-target-observation-snapshot";
import {
    BUILD_BYTES,
    BUILD_IDENTITY,
    compatibilityPolicy,
    makeExactFileDeclaration,
    REQUIRED_FACTS,
    TARGET_SCHEMA_ID,
    targetDiagnostic,
} from "./fixtures/native-project-target-context-catalog-fixtures";

const OLD_BUILD_IDENTITY = sha256Bytes(new TextEncoder().encode("older Guidance build"));

describe("observed native project target-context build catalog", () => {
    it("resolves and retains the production async build observation within one operation", async () => {
        const fixture = makeFixture();
        try {
            fixture.input.provider.renderContractDeclarations = [makeExactFileDeclaration("Skill")];
            const snapshot = createTargetCheckObservationSnapshot();
            const first = await resolveObservedNativeProjectTargetContextAsyncWithSnapshot(fixture.input, snapshot);
            expect(first.diagnostics).toEqual([]);
            expect(first).toMatchObject({
                status: "complete",
                targetContext: { agentRuntimeId: "ANTIGRAVITY_CLI", buildIdentity: BUILD_IDENTITY },
            });
            await expect(
                resolveObservedNativeProjectTargetContextAsyncWithSnapshot(fixture.input, snapshot),
            ).resolves.toMatchObject({
                status: "complete",
                targetContext: { buildIdentity: BUILD_IDENTITY },
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("fails closed for async target, declaration, and build-observation terminals", async () => {
        const missingTarget = makeFixture();
        const invalidDeclaration = makeFixture();
        const invalidPreflight = makeFixture();
        const missingBuild = makeFixture();
        try {
            missingTarget.input.probeResult.observation.targetCandidates = [];
            await expect(resolveObservedNativeProjectTargetContextAsyncWithSnapshot(missingTarget.input)).resolves.toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_target_candidate_missing" }],
            });

            invalidDeclaration.input.provider.renderContractDeclarations = [];
            await expect(
                resolveObservedNativeProjectTargetContextAsyncWithSnapshot(invalidDeclaration.input),
            ).resolves.toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_provider_declaration_invalid" }],
            });

            const weakEvidence = invalidPreflight.input.probeResult.observation.observedAgentRuntimes[0]?.installationEvidence[0];
            if (weakEvidence === undefined) throw new Error("async preflight fixture evidence is missing");
            weakEvidence.evidenceLevel = "documentation";
            await expect(
                resolveObservedNativeProjectTargetContextAsyncWithSnapshot(invalidPreflight.input),
            ).resolves.toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_build_evidence_untrusted" }],
            });

            const executablePath =
                missingBuild.input.probeResult.observation.observedAgentRuntimes[0]?.installationEvidence[0]?.path;
            if (executablePath === undefined) throw new Error("async build fixture path is missing");
            fs.rmSync(executablePath);
            await expect(resolveObservedNativeProjectTargetContextAsyncWithSnapshot(missingBuild.input)).resolves.toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_build_recheck_failed" }],
            });
        } finally {
            for (const fixture of [missingTarget, invalidDeclaration, invalidPreflight, missingBuild]) {
                fs.rmSync(fixture.root, { recursive: true, force: true });
            }
        }
    });

    it("selects the explicit global declaration authority when project and global schemas coexist", () => {
        const fixture = makeFixture();
        try {
            const descriptor = fixture.input.provider.agentRuntimes[0]!;
            const build = createVerifiedNativeGlobalGuidanceBuild({
                agentRuntimeId: descriptor.agentRuntimeId,
                versionText: "9.9.10-exact",
                buildIdentity: BUILD_IDENTITY,
                platform: "wsl",
                materializationProfileId: "fixture-global-guidance-v1",
                fixtureId: "fixture-global-guidance",
                targetRelativePath: "AGENTS.md",
                exactLoadMarker: "OAAM_GLOBAL_GUIDANCE",
                reverseFixtureId: "fixture-global-guidance-reverse",
            });
            const support = createNativeGlobalGuidanceProviderSupport({
                adapterId: fixture.input.provider.adapterId,
                adapterVersion: fixture.input.provider.version,
                agentRuntimes: fixture.input.provider.agentRuntimes,
                agentRuntimeId: descriptor.agentRuntimeId,
                outputContractId: "FIXTURE_NATIVE_GLOBAL_GUIDANCE_V1",
                materializationProfileId: build.materializationProfileId,
                target: {
                    relativePath: "AGENTS.md",
                    targetContextSchemaId: "FIXTURE_GLOBAL_TARGET_V1",
                    requiredFacts: REQUIRED_FACTS,
                },
                verifiedBuilds: [build],
            });
            fixture.input.provider.targetContextSchemas.push(support.targetContextSchema);
            fixture.input.provider.assetTargetCapabilities.push(support.targetCapability);
            fixture.input.provider.materializerCapabilities.push(support.materializerCapability);
            fixture.input.provider.renderContractDeclarations.push(support.renderContractDeclaration);
            const candidate = currentTargetCandidate(fixture);
            candidate.targetKind = "global";
            candidate.targetRootPath = fixture.input.probeResult.observation.platformContext.accessRootPath;
            fixture.input.targetRootPath = candidate.targetRootPath;
            fixture.input.projectRootPath = "";

            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "complete",
                targetContext: {
                    agentRuntimeId: descriptor.agentRuntimeId,
                    versionText: build.versionText,
                    buildIdentity: build.buildIdentity,
                    targetContextSchemaId: "FIXTURE_GLOBAL_TARGET_V1",
                },
                diagnostics: [],
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("does not require Project discovery when the exact target facts have no Project binding", () => {
        const fixture = makeFixture();
        try {
            fixture.input.provider.renderContractDeclarations.push(makeExactFileDeclaration("Skill"));
            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.projectDiscoveryStatus = "partial";

            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "complete",
                targetContext: {
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    targetContextSchemaId: TARGET_SCHEMA_ID,
                },
                diagnostics: [],
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("deduplicates compatible exact-file build rows into one production target context", () => {
        const fixture = makeFixture();
        try {
            fixture.input.provider.renderContractDeclarations.push(
                makeExactFileDeclaration("Workflow"),
                makeExactFileDeclaration("Skill"),
                makeExactFileDeclaration("Subagent"),
            );

            const result = resolveObservedNativeProjectTargetContext(fixture.input);
            expect(result).toMatchObject({
                status: "complete",
                targetContext: {
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    versionText: "9.9.10-exact",
                    buildIdentity: BUILD_IDENTITY,
                    targetContextSchemaId: TARGET_SCHEMA_ID,
                    renderFacts: [
                        { key: "fixture.channel", value: "stable", evidenceLevel: "agent_runtime_verified" },
                        { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
                    ],
                },
                diagnostics: [],
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("binds the current executable identity to one Provider-declared non-later anchor", () => {
        const fixture = makeFixture();
        try {
            const declaration = makeExactFileDeclaration("Skill");
            const anchor = declaration.verifiedBuilds[0]!;
            anchor.versionText = "9.9.9";
            anchor.buildIdentity = OLD_BUILD_IDENTITY;
            declaration.buildCompatibility = compatibilityPolicy();
            fixture.input.provider.renderContractDeclarations.push(declaration);

            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "complete",
                targetContext: {
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    versionText: "9.9.10-exact",
                    buildIdentity: BUILD_IDENTITY,
                },
            });

            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.versionText = "9.9.8";
            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_build_unverified" }],
            });

            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.versionText = "current-main";
            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "complete",
                targetContext: { versionText: "current-main", buildIdentity: BUILD_IDENTITY },
            });

            declaration.buildCompatibility.deniedBuilds = [
                {
                    versionText: "current-main",
                    buildIdentity: BUILD_IDENTITY,
                    reasonCode: "known_loader_regression",
                },
            ];
            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_build_unverified" }],
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("does not borrow an exact-file build whose required target facts differ", () => {
        const fixture = makeFixture();
        try {
            fixture.input.provider.renderContractDeclarations.push(
                makeExactFileDeclaration("Workflow", { "fixture.channel": "preview" }),
            );

            expect(resolveObservedNativeProjectGuidanceTargetContext(fixture.input)).toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_build_unverified" }],
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("resolves an exact-file-only runtime without inventing a Guidance declaration", () => {
        const fixture = makeFixture();
        try {
            fixture.input.provider.renderContractDeclarations = [makeExactFileDeclaration("Skill")];

            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "complete",
                targetContext: {
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    versionText: "9.9.10-exact",
                    buildIdentity: BUILD_IDENTITY,
                    targetContextSchemaId: TARGET_SCHEMA_ID,
                },
                diagnostics: [],
            });
            expect(resolveObservedNativeProjectGuidanceTargetContext(fixture.input)).toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_provider_declaration_invalid" }],
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("uses the exact target-fact fallback for a declaration with no project/global scope prefix", () => {
        const fixture = makeFixture();
        try {
            const declaration = makeExactFileDeclaration("Skill");
            declaration.declarationKind = "unknown_native_declaration" as never;
            fixture.input.provider.renderContractDeclarations = [declaration];

            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "complete",
                targetContext: { targetContextSchemaId: TARGET_SCHEMA_ID },
                diagnostics: [],
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });
    it("rejects runtime declarations that disagree on target-context authority", () => {
        const fixture = makeFixture();
        try {
            const second = makeExactFileDeclaration("Skill");
            second.target.targetContextSchemaId = "FIXTURE_SECOND_PROJECT_TARGET_V1";
            fixture.input.provider.renderContractDeclarations = [makeExactFileDeclaration("Workflow"), second];

            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "failed",
                diagnostics: [
                    {
                        code: "native_guidance_provider_declaration_invalid",
                        message: expect.stringContaining("do not share one target-context schema and fact set"),
                    },
                ],
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("requires one current ready target candidate for the selected runtime and write root", () => {
        expectTargetFailure((fixture) => {
            fixture.input.probeResult.observation.targetCandidates = [];
        }, "native_guidance_target_candidate_missing");
        expectTargetFailure((fixture) => {
            fixture.input.probeResult.observation.targetCandidates.push(structuredClone(currentTargetCandidate(fixture)));
        }, "native_guidance_target_candidate_ambiguous");
        expectTargetFailure((fixture) => {
            currentTargetApplicability(fixture).agentRuntimeId = "CLAUDE_CODE_CLI";
        }, "native_guidance_target_applicability_invalid");
        expectTargetFailure((fixture) => {
            currentTargetApplicability(fixture).status = "unknown";
        }, "native_guidance_target_not_ready");
        expectTargetFailure((fixture) => {
            currentTargetLocatorEvidence(fixture).evidenceLevel = "docs_declared";
        }, "native_guidance_target_not_ready");
        expectTargetFailure((fixture) => {
            currentTargetCandidate(fixture).targetKind = "unknown";
        }, "native_guidance_target_candidate_invalid");
        expectTargetFailure((fixture) => {
            currentTargetCandidate(fixture).diagnostics = [targetDiagnostic("target_error")];
        }, "native_guidance_target_candidate_invalid");
        expectTargetFailure((fixture) => {
            currentTargetApplicability(fixture).status = "invalid";
        }, "native_guidance_target_not_ready");
        expectTargetFailure((fixture) => {
            currentTargetApplicability(fixture).diagnostics = [targetDiagnostic("applicability_error")];
        }, "native_guidance_target_not_ready");
        expectTargetFailure((fixture) => {
            currentTargetCandidate(fixture).targetRootPath = path.join(fixture.root, "replacement");
        }, "native_guidance_target_candidate_missing");
    });

    it("fails the production Guidance resolver before declaration or filesystem work when no target is authorized", () => {
        const fixture = makeFixture();
        try {
            fixture.input.probeResult.observation.targetCandidates = [];
            expect(resolveObservedNativeProjectGuidanceTargetContext(fixture.input)).toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_target_candidate_missing" }],
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("selects the strongest current target locator without trusting documentation-only evidence", () => {
        const fixture = makeFixture();
        try {
            const applicability = currentTargetApplicability(fixture);
            const evidence = (
                evidenceLevel: "docs_declared" | "user_provided" | "local_artifact" | "agent_runtime_verified",
            ) => ({
                locatorKind: "user_provided_path" as const,
                locatorKey: evidenceLevel,
                evidenceLevel,
            });
            applicability.locatorEvidence = [
                evidence("docs_declared"),
                evidence("user_provided"),
                evidence("local_artifact"),
                evidence("agent_runtime_verified"),
            ];
            expect(resolveReadyObservedTargetCandidate(fixture.input)).toMatchObject({
                status: "complete",
                candidate: { evidenceLevel: "agent_runtime_verified" },
            });
            applicability.locatorEvidence = [evidence("user_provided"), evidence("local_artifact")];
            expect(resolveReadyObservedTargetCandidate(fixture.input)).toMatchObject({
                status: "complete",
                candidate: { evidenceLevel: "local_artifact" },
            });
            applicability.locatorEvidence = [evidence("user_provided")];
            expect(resolveReadyObservedTargetCandidate(fixture.input)).toMatchObject({
                status: "complete",
                candidate: { evidenceLevel: "user_provided" },
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("does not let a generic project/global declaration authorize an arbitrary directory target", () => {
        const fixture = makeFixture();
        try {
            currentTargetCandidate(fixture).targetKind = "directory";
            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_provider_declaration_invalid" }],
            });
            expect(resolveObservedNativeProjectGuidanceTargetContext(fixture.input)).toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_provider_declaration_invalid" }],
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });
    it("selects directory target authority by the requested Project or Global ownership scope", () => {
        const fixture = makeFixture();
        try {
            addUserSelectedProjectBinding(fixture);
            const descriptor = fixture.input.provider.agentRuntimes[0]!;
            const projectDirectory = createNativeProjectGuidanceProviderSupport({
                adapterId: fixture.input.provider.adapterId,
                adapterVersion: fixture.input.provider.version,
                agentRuntimes: fixture.input.provider.agentRuntimes,
                agentRuntimeId: descriptor.agentRuntimeId,
                outputContractId: "FIXTURE_PROJECT_DIRECTORY_GUIDANCE_V1",
                materializationProfileId: "fixture-project-directory-v1",
                target: {
                    relativePath: "AGENTS.md",
                    targetContextSchemaId: "FIXTURE_PROJECT_DIRECTORY_TARGET_V1",
                    requiredFacts: {
                        "oaam.project-binding": "registered",
                        "oaam.target-kind": "directory",
                    },
                },
                verifiedBuilds: [
                    {
                        agentRuntimeId: descriptor.agentRuntimeId,
                        versionText: "9.9.10-exact",
                        buildIdentity: BUILD_IDENTITY,
                        platform: "wsl",
                        materializationProfileId: "fixture-project-directory-v1",
                        fixtureSetFingerprint: sha256Bytes(new TextEncoder().encode("project directory fixture")),
                    },
                ],
            });
            const globalBuild = createVerifiedNativeGlobalGuidanceBuild({
                agentRuntimeId: descriptor.agentRuntimeId,
                versionText: "9.9.10-exact",
                buildIdentity: BUILD_IDENTITY,
                platform: "wsl",
                materializationProfileId: "fixture-global-directory-v1",
                fixtureId: "fixture-global-directory",
                targetRelativePath: "AGENTS.md",
                exactLoadMarker: "OAAM_GLOBAL_DIRECTORY",
                reverseFixtureId: "fixture-global-directory-reverse",
            });
            const globalDirectory = createNativeGlobalGuidanceProviderSupport({
                adapterId: fixture.input.provider.adapterId,
                adapterVersion: fixture.input.provider.version,
                agentRuntimes: fixture.input.provider.agentRuntimes,
                agentRuntimeId: descriptor.agentRuntimeId,
                outputContractId: "FIXTURE_GLOBAL_DIRECTORY_GUIDANCE_V1",
                materializationProfileId: globalBuild.materializationProfileId,
                target: {
                    relativePath: "AGENTS.md",
                    targetContextSchemaId: "FIXTURE_GLOBAL_DIRECTORY_TARGET_V1",
                    requiredFacts: { "oaam.target-kind": "directory" },
                },
                verifiedBuilds: [globalBuild],
            });
            fixture.input.provider.targetContextSchemas = [
                projectDirectory.targetContextSchema,
                globalDirectory.targetContextSchema,
            ];
            fixture.input.provider.renderContractDeclarations = [
                projectDirectory.renderContractDeclaration,
                globalDirectory.renderContractDeclaration,
            ];
            currentTargetCandidate(fixture).targetKind = "directory";

            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "complete",
                targetContext: {
                    targetContextSchemaId: "FIXTURE_PROJECT_DIRECTORY_TARGET_V1",
                    renderFacts: expect.arrayContaining([
                        { key: "oaam.project-binding", value: "registered", evidenceLevel: "user_provided" },
                        { key: "oaam.target-kind", value: "directory", evidenceLevel: "user_provided" },
                    ]),
                },
            });

            fixture.input.projectRootPath = "";
            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "complete",
                targetContext: {
                    targetContextSchemaId: "FIXTURE_GLOBAL_DIRECTORY_TARGET_V1",
                    renderFacts: expect.arrayContaining([
                        { key: "oaam.target-kind", value: "directory", evidenceLevel: "user_provided" },
                    ]),
                },
            });

            const conflictingProject = createNativeProjectGuidanceProviderSupport({
                adapterId: fixture.input.provider.adapterId,
                adapterVersion: fixture.input.provider.version,
                agentRuntimes: fixture.input.provider.agentRuntimes,
                agentRuntimeId: descriptor.agentRuntimeId,
                outputContractId: "FIXTURE_SECOND_PROJECT_DIRECTORY_GUIDANCE_V1",
                materializationProfileId: "fixture-second-project-directory-v1",
                target: {
                    relativePath: "AGENTS.md",
                    targetContextSchemaId: "FIXTURE_SECOND_PROJECT_DIRECTORY_TARGET_V1",
                    requiredFacts: {
                        "oaam.project-binding": "registered",
                        "oaam.target-kind": "directory",
                    },
                },
                verifiedBuilds: [
                    {
                        agentRuntimeId: descriptor.agentRuntimeId,
                        versionText: "9.9.10-exact",
                        buildIdentity: BUILD_IDENTITY,
                        platform: "wsl",
                        materializationProfileId: "fixture-second-project-directory-v1",
                        fixtureSetFingerprint: sha256Bytes(new TextEncoder().encode("second project directory fixture")),
                    },
                ],
            });
            fixture.input.projectRootPath = fixture.input.targetRootPath;
            fixture.input.provider.targetContextSchemas.push(conflictingProject.targetContextSchema);
            fixture.input.provider.renderContractDeclarations.push(conflictingProject.renderContractDeclaration);
            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_provider_declaration_invalid" }],
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });
    it("rejects a runtime with no native target declaration", () => {
        const fixture = makeFixture();
        try {
            fixture.input.provider.renderContractDeclarations = [];

            expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
                status: "failed",
                diagnostics: [
                    {
                        code: "native_guidance_provider_declaration_invalid",
                        message: expect.stringContaining("requires at least one runtime declaration"),
                    },
                ],
            });
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });
});

function makeFixture(): { root: string; input: ResolveObservedNativeProjectGuidanceTargetContextInput } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-observed-target-catalog-"));
    const executableRoot = path.join(root, "bin");
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(executableRoot);
    fs.mkdirSync(projectRoot);
    const executablePath = path.join(executableRoot, "consumer");
    fs.writeFileSync(executablePath, BUILD_BYTES, { mode: 0o755 });
    const descriptor = {
        agentRuntimeId: "ANTIGRAVITY_CLI" as const,
        displayName: "Target context fixture",
        entryClass: "cli" as const,
    };
    const guidanceBuild: VerifiedNativeProjectGuidanceBuild = {
        agentRuntimeId: descriptor.agentRuntimeId,
        versionText: "9.9.9-guidance",
        buildIdentity: OLD_BUILD_IDENTITY,
        platform: "wsl",
        materializationProfileId: "fixture-guidance-v1",
        fixtureSetFingerprint: sha256Bytes(new TextEncoder().encode("guidance fixture")),
    };
    const support = createNativeProjectGuidanceProviderSupport({
        adapterId: "ANTIGRAVITY",
        adapterVersion: "0.3.0",
        agentRuntimes: [descriptor],
        agentRuntimeId: descriptor.agentRuntimeId,
        outputContractId: "FIXTURE_NATIVE_PROJECT_GUIDANCE_V1",
        materializationProfileId: guidanceBuild.materializationProfileId,
        target: { relativePath: "AGENTS.md", targetContextSchemaId: TARGET_SCHEMA_ID, requiredFacts: REQUIRED_FACTS },
        verifiedBuilds: [guidanceBuild],
    });
    const provider: AdapterProviderSummary = {
        adapterId: "ANTIGRAVITY",
        displayName: "Target context fixture",
        version: "0.3.0",
        enabled: true,
        agentRuntimes: [descriptor],
        targetContextSchemas: [support.targetContextSchema],
        assetSourceCapabilities: [],
        assetTargetCapabilities: [support.targetCapability],
        materializerCapabilities: [support.materializerCapability],
        renderContractDeclarations: [support.renderContractDeclaration],
    };
    const probeResult: ProbeResult = {
        status: "partial",
        observation: {
            adapterId: provider.adapterId,
            platformContext: { platform: "wsl", platformInstanceId: "wsl:fixture", accessRootPath: root },
            observedAgentRuntimes: [
                {
                    agentRuntimeId: descriptor.agentRuntimeId,
                    versionText: "9.9.10-exact",
                    installationEvidence: [
                        {
                            kind: "executable",
                            path: executablePath,
                            evidenceLevel: "local_artifact",
                            diagnostics: [],
                        },
                    ],
                    sourceRootIds: [],
                    agentRuntimeResourceIds: [],
                    observedProjectIds: [],
                    installationStatus: "available",
                    projectDiscoveryStatus: "complete",
                    diagnostics: [],
                },
            ],
            sourceRoots: [],
            agentRuntimeResources: [],
            observedProjects: [],
            targetCandidates: [
                {
                    targetCandidateId: "target",
                    targetRootPath: projectRoot,
                    targetKind: "project",
                    displayName: "Target context fixture",
                    entryApplicabilities: [
                        {
                            agentRuntimeId: descriptor.agentRuntimeId,
                            status: "ready_for_plan",
                            locatorEvidence: [
                                {
                                    locatorKind: "user_provided_path",
                                    locatorKey: "fixture-project",
                                    evidenceLevel: "user_provided",
                                },
                            ],
                            diagnostics: [],
                        },
                    ],
                    diagnostics: [],
                },
            ],
        },
        diagnostics: [],
    };
    return {
        root,
        input: {
            provider,
            probeResult,
            agentRuntimeId: descriptor.agentRuntimeId,
            targetRootPath: projectRoot,
            projectRootPath: projectRoot,
        },
    };
}

function addUserSelectedProjectBinding(fixture: ReturnType<typeof makeFixture>): void {
    const observation = fixture.input.probeResult.observation;
    const runtime = observation.observedAgentRuntimes[0];
    if (runtime === undefined) throw new Error("runtime fixture is missing");
    runtime.sourceRootIds = ["project-root"];
    runtime.observedProjectIds = ["project-a"];
    observation.sourceRoots = [
        {
            sourceRootId: "project-root",
            rootRole: "project_actual",
            sourceDomain: "project_root",
            path: fixture.input.projectRootPath,
            accessStatus: "available",
            locatorEvidence: [
                {
                    locatorKind: "user_provided_path",
                    locatorKey: "probe_project_root",
                    evidenceLevel: "user_provided",
                },
            ],
            diagnostics: [],
        },
    ];
    observation.observedProjects = [
        {
            observedProjectId: "project-a",
            runtimeProjectKey: "project-a",
            displayName: "Project A",
            workspaces: [{ sourceRootId: "project-root", role: "primary" }],
            evidence: [
                {
                    evidenceKind: "invocation",
                    locatorKey: "probe_project_root",
                    evidenceLevel: "user_provided",
                },
            ],
            diagnostics: [],
        },
    ];
}

type Fixture = ReturnType<typeof makeFixture>;

function currentTargetCandidate(fixture: Fixture) {
    const candidate = fixture.input.probeResult.observation.targetCandidates[0];
    if (candidate === undefined) throw new Error("target candidate fixture is missing");
    return candidate;
}

function currentTargetApplicability(fixture: Fixture) {
    const applicability = currentTargetCandidate(fixture).entryApplicabilities[0];
    if (applicability === undefined) throw new Error("target applicability fixture is missing");
    return applicability;
}

function currentTargetLocatorEvidence(fixture: Fixture) {
    const evidence = currentTargetApplicability(fixture).locatorEvidence[0];
    if (evidence === undefined) throw new Error("target locator evidence fixture is missing");
    return evidence;
}

function expectTargetFailure(mutate: (fixture: Fixture) => void, code: string): void {
    const fixture = makeFixture();
    try {
        mutate(fixture);
        expect(resolveObservedNativeProjectTargetContext(fixture.input)).toMatchObject({
            status: "failed",
            diagnostics: [{ code }],
        });
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
}
