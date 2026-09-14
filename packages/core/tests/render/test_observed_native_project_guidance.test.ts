import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import { describe, expect, it } from "vitest";
import {
    createNativeProjectGuidanceProviderSupport,
    type NativeProjectGuidanceObservationDependenciesForTest,
    nativeProjectGuidanceRegistryComponentsForTest,
    resolveObservedNativeProjectGuidanceTargetContext,
    resolveObservedNativeProjectGuidanceTargetContextForTest,
    resolveObservedNativeProjectTargetContextForTest,
} from "../../src/render/native-project-guidance";
import type { OperationDiagnostic } from "../../src/types";
import {
    BUILD_BYTES,
    BUILD_IDENTITY,
    type Fixture,
    makeFixture,
} from "./fixtures/observed-native-project-guidance-test-fixtures";

describe("observed native project Guidance target context", () => {
    it("binds a partial family probe to one complete CLI entry and registered project", () => {
        const fixture = makeFixture();
        const result = resolveObservedNativeProjectGuidanceTargetContextForTest(fixture.input, fixture.dependencies);

        expect(result).toMatchObject({
            status: "complete",
            targetContext: {
                agentRuntimeId: "ANTIGRAVITY_CLI",
                versionText: "9.9.9-test",
                buildIdentity: BUILD_IDENTITY,
                renderFacts: [
                    {
                        key: "oaam.platform",
                        value: "wsl",
                        evidenceLevel: "agent_runtime_verified",
                    },
                    {
                        key: "oaam.project-binding",
                        value: "registered",
                        evidenceLevel: "local_artifact",
                    },
                ],
            },
            diagnostics: [],
        });
    });

    it("binds a directory target to its own declaration while retaining the registered Project root", () => {
        const fixture = makeFixture();
        const descriptor = fixture.input.provider.agentRuntimes[0];
        if (descriptor === undefined) throw new Error("directory target runtime fixture is missing");
        const directoryRoot = "/fixture/profile/projects/project-a/memory";
        const directoryBuild = {
            ...fixture.build,
            materializationProfileId: "fixture-project-keyed-directory-v1",
        };
        const support = createNativeProjectGuidanceProviderSupport({
            adapterId: fixture.input.provider.adapterId,
            adapterVersion: fixture.input.provider.version,
            agentRuntimes: [descriptor],
            agentRuntimeId: fixture.build.agentRuntimeId,
            outputContractId: "FIXTURE_PROJECT_KEYED_DIRECTORY_V1",
            materializationProfileId: directoryBuild.materializationProfileId,
            target: {
                relativePath: "MEMORY.md",
                targetContextSchemaId: "FIXTURE_PROJECT_KEYED_DIRECTORY_TARGET_V1",
                requiredFacts: {
                    "oaam.project-binding": "registered",
                    "oaam.target-kind": "directory",
                },
            },
            verifiedBuilds: [directoryBuild],
        });
        fixture.input.provider.targetContextSchemas.push(support.targetContextSchema);
        fixture.input.provider.renderContractDeclarations.push(support.renderContractDeclaration);
        fixture.input.targetRootPath = directoryRoot;
        currentTargetCandidate(fixture).targetRootPath = directoryRoot;
        currentTargetCandidate(fixture).targetKind = "directory";
        fixture.dependencies.verifiedBuilds = [directoryBuild];

        expect(resolveObservedNativeProjectTargetContextForTest(fixture.input, fixture.dependencies)).toMatchObject({
            status: "complete",
            targetContext: {
                targetContextSchemaId: "FIXTURE_PROJECT_KEYED_DIRECTORY_TARGET_V1",
                renderFacts: [
                    { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
                    { key: "oaam.project-binding", value: "registered", evidenceLevel: "local_artifact" },
                    { key: "oaam.target-kind", value: "directory", evidenceLevel: "local_artifact" },
                ],
            },
            diagnostics: [],
        });
        expect(fixture.input.projectRootPath).toBe("/fixture/project");
        expect(fixture.input.targetRootPath).toBe(directoryRoot);

        fixture.input.provider.renderContractDeclarations.pop();
        expect(resolveObservedNativeProjectTargetContextForTest(fixture.input, fixture.dependencies)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_provider_declaration_invalid" }],
        });

        fixture.input.probeResult.observation.targetCandidates = [];
        expect(resolveObservedNativeProjectTargetContextForTest(fixture.input, fixture.dependencies)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_target_candidate_missing" }],
        });
    });

    it("returns a typed failure when the provider handshake changes after exact observation", () => {
        const fixture = makeFixture();
        fixture.input.provider.targetContextSchemas = [];

        expect(resolveWithFixture(fixture)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_provider_handshake_invalid" }],
        });
    });

    it("fails closed before filesystem access when the provider declaration is missing", () => {
        const fixture = makeFixture();
        fixture.input.provider.renderContractDeclarations = [];
        expect(resolveObservedNativeProjectGuidanceTargetContext(fixture.input)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_provider_declaration_invalid" }],
        });
    });

    it("preserves verified registry evidence and accepts it in the exact applicability predicate", () => {
        const fixture = makeFixture({ projectEvidenceLevel: "agent_runtime_verified" });
        fixture.input.probeResult.observation.observedAgentRuntimes[0]!.versionText = fixture.build.versionText;

        const result = resolveObservedNativeProjectGuidanceTargetContextForTest(fixture.input, fixture.dependencies);
        expect(result.status).toBe("complete");
        if (result.status !== "complete") throw new Error("expected complete target context");
        expect(result.targetContext.renderFacts[1]?.evidenceLevel).toBe("agent_runtime_verified");

        const components = nativeProjectGuidanceRegistryComponentsForTest([fixture.input.provider], [fixture.build]);
        expect(components.targetApplicabilityPredicates).toHaveLength(1);
        expect(components.targetApplicabilityPredicates[0]?.evaluate(result.targetContext)).toBe(true);
        const docsOnly = structuredClone(result.targetContext);
        docsOnly.renderFacts[1]!.evidenceLevel = "docs_declared";
        expect(components.targetApplicabilityPredicates[0]?.evaluate(docsOnly)).toBe(false);
    });

    it("uses the weaker truthful level when project and root evidence differ", () => {
        const fixture = makeFixture({ projectEvidenceLevel: "agent_runtime_verified" });
        fixture.input.probeResult.observation.sourceRoots[0]!.locatorEvidence[0]!.evidenceLevel = "local_artifact";
        const result = resolveObservedNativeProjectGuidanceTargetContextForTest(fixture.input, fixture.dependencies);
        expect(result.status).toBe("complete");
        if (result.status !== "complete") throw new Error("expected complete target context");
        expect(result.targetContext.renderFacts[1]?.evidenceLevel).toBe("local_artifact");
    });

    it("selects the strongest usable binding when duplicate runtime project keys share one root", () => {
        const fixture = makeFixture();
        const baseProject = fixture.input.probeResult.observation.observedProjects[0]!;
        fixture.input.probeResult.observation.observedProjects.push(
            {
                ...structuredClone(baseProject),
                observedProjectId: "project-b",
                evidence: [
                    {
                        evidenceKind: "agent_runtime_resource",
                        agentRuntimeResourceId: "registry-resource",
                        locatorKey: "verified-project",
                        evidenceLevel: "agent_runtime_verified",
                    },
                ],
            },
            {
                ...structuredClone(baseProject),
                observedProjectId: "project-c",
                evidence: [
                    {
                        evidenceKind: "agent_runtime_resource",
                        agentRuntimeResourceId: "registry-resource",
                        locatorKey: "local-project",
                        evidenceLevel: "local_artifact",
                    },
                ],
            },
        );
        fixture.input.probeResult.observation.observedAgentRuntimes[0]!.observedProjectIds.push("project-b", "project-c");
        fixture.input.probeResult.observation.sourceRoots[0]!.locatorEvidence[0]!.evidenceLevel = "agent_runtime_verified";
        fixture.input.probeResult.observation.agentRuntimeResources[0]!.locatorEvidence[0]!.evidenceLevel =
            "agent_runtime_verified";

        const result = resolveWithFixture(fixture);
        expect(result.status).toBe("complete");
        if (result.status !== "complete") throw new Error("expected complete target context");
        expect(result.targetContext.renderFacts[1]?.evidenceLevel).toBe("agent_runtime_verified");
    });

    it("rejects failed/foreign/malformed probe and target-root boundaries", () => {
        expectFailure((fixture) => {
            fixture.input.probeResult.status = "failed";
        }, "native_guidance_probe_failed");
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.adapterId = "CLAUDECODE";
        }, "native_guidance_probe_owner_mismatch");
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.platformContext.accessRootPath = "relative";
        }, "native_guidance_target_root_invalid");
        expectFailure((fixture) => {
            fixture.input.targetRootPath = "relative";
        }, "native_guidance_target_root_invalid");
        expectFailure((fixture) => {
            fixture.input.targetRootPath = "/outside/project";
        }, "native_guidance_target_root_invalid");
        expectFailure((fixture) => {
            fixture.input.projectRootPath = "relative";
        }, "native_guidance_target_root_invalid");
        expectFailure((fixture) => {
            fixture.input.projectRootPath = "/outside/project";
        }, "native_guidance_target_root_invalid");
        const windows = makeFixture();
        windows.input.probeResult.observation.platformContext = {
            platform: "win32",
            platformInstanceId: "windows-test",
            accessRootPath: "C:\\fixture",
        };
        windows.input.targetRootPath = "D:\\project";
        expect(resolveWithFixture(windows)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_target_root_invalid" }],
        });
    });

    it("requires one usable runtime entry owned by the provider", () => {
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedAgentRuntimes = [];
        }, "native_guidance_runtime_observation_invalid");
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedAgentRuntimes.push(
                structuredClone(fixture.input.probeResult.observation.observedAgentRuntimes[0]!),
            );
        }, "native_guidance_runtime_observation_invalid");
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.installationStatus = "not_found";
        }, "native_guidance_runtime_unavailable");
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.projectDiscoveryStatus = "partial";
        }, "native_guidance_runtime_unavailable");
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.diagnostics = [
                testDiagnostic("runtime_error", "error"),
            ];
        }, "native_guidance_runtime_unavailable");
        expectFailure((fixture) => {
            fixture.input.provider.agentRuntimes = [];
        }, "native_guidance_runtime_owner_mismatch");
    });

    it("requires distinct trusted canonical build-bearing files inside the platform root", () => {
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence = [];
        }, "native_guidance_build_evidence_invalid");
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.kind = "install_root";
        }, "native_guidance_build_evidence_invalid");
        expectFailure((fixture) => {
            const evidence = fixture.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence[0]!;
            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence.push(structuredClone(evidence));
        }, "native_guidance_build_evidence_invalid");
        for (const mutate of [
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.evidenceLevel =
                    "docs_declared";
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.diagnostics = [
                    testDiagnostic("executable_error", "error"),
                ];
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.path = "relative";
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.path =
                    "/outside/consumer";
            },
        ]) {
            expectFailure(mutate, "native_guidance_build_evidence_untrusted");
        }
    });

    it("selects one exact app-bundle match without requiring executable mode", () => {
        const fixture = makeFixture();
        const runtime = fixture.input.probeResult.observation.observedAgentRuntimes[0]!;
        const launcherPath = runtime.installationEvidence[0]!.path;
        const bundlePath = "/fixture/app/resources/consumer.cjs";
        runtime.installationEvidence.push({
            kind: "app_bundle",
            path: bundlePath,
            evidenceLevel: "local_artifact",
            diagnostics: [],
        });
        fixture.dependencies.readBuildArtifact = (filePath) =>
            filePath === bundlePath
                ? stableRead(BUILD_BYTES, false)
                : stableRead(new TextEncoder().encode(`launcher:${launcherPath}`), true);

        expect(resolveWithFixture(fixture)).toMatchObject({
            status: "complete",
            targetContext: { buildIdentity: BUILD_IDENTITY },
        });
    });

    it("accepts an app bundle as the only build-bearing evidence", () => {
        const fixture = makeFixture();
        fixture.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence = [
            {
                kind: "app_bundle",
                path: "/fixture/app/resources/consumer.cjs",
                evidenceLevel: "local_artifact",
                diagnostics: [],
            },
        ];
        fixture.dependencies.readBuildArtifact = () => stableRead(BUILD_BYTES, false);

        expect(resolveWithFixture(fixture).status).toBe("complete");
    });

    it("fails closed when any declared build-bearing file cannot be trusted or re-opened", () => {
        const fixture = makeFixture();
        const bundlePath = "/fixture/app/resources/consumer.cjs";
        fixture.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence.push({
            kind: "app_bundle",
            path: bundlePath,
            evidenceLevel: "docs_declared",
            diagnostics: [],
        });
        expect(resolveWithFixture(fixture)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_build_evidence_untrusted", path: bundlePath }],
        });

        const unreadable = makeFixture();
        unreadable.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence.push({
            kind: "app_bundle",
            path: bundlePath,
            evidenceLevel: "local_artifact",
            diagnostics: [],
        });
        unreadable.dependencies.readBuildArtifact = (filePath) => {
            if (filePath === bundlePath) throw new Error("unreadable bundle");
            return stableRead(BUILD_BYTES, true);
        };
        expect(resolveWithFixture(unreadable)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_build_recheck_failed", path: bundlePath }],
        });
    });

    it("maps safe-filesystem and unexpected build-file recheck failures without throwing", () => {
        expectFailure(
            () => undefined,
            "native_guidance_build_recheck_failed",
            () => {
                throw new SafeFilesystemError({
                    failureKind: "permission_denied",
                    operation: "read_regular_file",
                    targetPath: "/fixture/bin/consumer",
                    message: "denied",
                });
            },
            "permission_denied",
        );
        expectFailure(
            () => undefined,
            "native_guidance_build_recheck_failed",
            () => {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation: "read_regular_file",
                    targetPath: "/fixture/bin/consumer",
                    message: "changed",
                });
            },
            "verification_failed",
        );
        expectFailure(
            () => undefined,
            "native_guidance_build_recheck_failed",
            () => {
                throw new Error("unexpected");
            },
            "verification_failed",
        );
    });

    it("rejects mode, updater byte replacement, duplicate catalog rows and version mismatch", () => {
        expectFailure(
            () => undefined,
            "native_guidance_build_mode_invalid",
            () => stableRead(BUILD_BYTES, false),
        );
        expectFailure(
            () => undefined,
            "native_guidance_build_unverified",
            () => stableRead(new TextEncoder().encode("updated bytes"), true),
        );
        const duplicate = makeFixture();
        duplicate.dependencies.verifiedBuilds = [duplicate.build, structuredClone(duplicate.build)];
        expect(resolveWithFixture(duplicate)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_build_catalog_ambiguous" }],
        });
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.versionText = " 9.9.9-test";
        }, "native_guidance_version_mismatch");
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.versionText = "9.9.8";
        }, "native_guidance_version_mismatch");

        const multipleVersionMismatches = makeFixture();
        multipleVersionMismatches.input.probeResult.observation.observedAgentRuntimes[0]!.versionText = "9.9.8";
        multipleVersionMismatches.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence.push({
            kind: "app_bundle",
            path: "/fixture/app/resources/consumer.cjs",
            evidenceLevel: "local_artifact",
            diagnostics: [],
        });
        expect(resolveWithFixture(multipleVersionMismatches)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_build_catalog_ambiguous" }],
        });
    });

    it("rejects multiple matching artifacts and cross-platform catalog rows", () => {
        const ambiguous = makeFixture();
        ambiguous.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence.push({
            kind: "app_bundle",
            path: "/fixture/app/resources/consumer.cjs",
            evidenceLevel: "local_artifact",
            diagnostics: [],
        });
        expect(resolveWithFixture(ambiguous)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_build_catalog_ambiguous" }],
        });

        const crossPlatform = makeFixture();
        crossPlatform.dependencies.verifiedBuilds = [{ ...crossPlatform.build, platform: "win32" }];
        expect(resolveWithFixture(crossPlatform)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_build_unverified" }],
        });
    });

    it("selects only the current platform row when verified builds share version and bytes", () => {
        const fixture = makeFixture();
        fixture.dependencies.verifiedBuilds = [
            fixture.build,
            {
                ...fixture.build,
                platform: "win32",
            },
        ];

        expect(resolveWithFixture(fixture)).toMatchObject({
            status: "complete",
            targetContext: {
                agentRuntimeId: fixture.build.agentRuntimeId,
                versionText: fixture.build.versionText,
                buildIdentity: fixture.build.buildIdentity,
                renderFacts: [
                    {
                        key: "oaam.platform",
                        value: "wsl",
                        evidenceLevel: "agent_runtime_verified",
                    },
                    expect.any(Object),
                ],
            },
            diagnostics: [],
        });
    });

    it("requires project/root evidence from the same selected runtime", () => {
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.observedProjectIds = [];
        }, "native_guidance_project_binding_missing");
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.sourceRootIds = [];
        }, "native_guidance_project_binding_missing");
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedProjects[0]!.workspaces[0]!.role = "additional";
        }, "native_guidance_project_binding_missing");
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.observedProjects[0]!.diagnostics = [testDiagnostic("project_error", "error")];
        }, "native_guidance_project_binding_missing");
        expectFailure((fixture) => {
            fixture.input.probeResult.observation.sourceRoots = [];
        }, "native_guidance_project_binding_missing");
        for (const mutate of [
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.sourceRoots[0]!.path = "/fixture/other-project";
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.sourceRoots[0]!.rootRole = "source";
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.sourceRoots[0]!.sourceDomain = "family_shared";
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.sourceRoots[0]!.accessStatus = "unknown";
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.sourceRoots[0]!.diagnostics = [testDiagnostic("root_error", "error")];
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.observedProjects[0]!.evidence = [
                    {
                        evidenceKind: "invocation",
                        locatorKey: "user-authorized-only",
                        evidenceLevel: "user_provided",
                    },
                ];
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.observedAgentRuntimes[0]!.agentRuntimeResourceIds = [];
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.observedProjects[0]!.evidence[0]!.evidenceLevel = "docs_declared";
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.sourceRoots[0]!.locatorEvidence[0]!.evidenceLevel = "agent_answer";
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.sourceRoots[0]!.locatorEvidence[0]!.locatorKind = "user_provided_path";
            },
        ]) {
            expectFailure(mutate, "native_guidance_project_binding_missing");
        }
    });

    it("accepts only one exact user-selected invocation anchor at the registered Project root", () => {
        const fixture = userSelectedProjectFixture();

        expect(resolveWithFixture(fixture)).toMatchObject({
            status: "complete",
            targetContext: {
                renderFacts: expect.arrayContaining([
                    {
                        key: "oaam.project-binding",
                        value: "registered",
                        evidenceLevel: "user_provided",
                    },
                ]),
            },
            diagnostics: [],
        });

        const combined = makeFixture();
        combined.input.probeResult.observation.observedProjects[0]?.evidence.push({
            evidenceKind: "invocation",
            locatorKey: "probe_project_root",
            evidenceLevel: "user_provided",
        });
        combined.input.probeResult.observation.sourceRoots[0]?.locatorEvidence.push({
            locatorKind: "user_provided_path",
            locatorKey: "probe_project_root",
            evidenceLevel: "user_provided",
        });
        expect(resolveWithFixture(combined)).toMatchObject({
            status: "complete",
            targetContext: {
                renderFacts: expect.arrayContaining([
                    expect.objectContaining({ key: "oaam.project-binding", evidenceLevel: "local_artifact" }),
                ]),
            },
        });

        for (const mutate of [
            (invalid: Fixture) => {
                invalid.input.probeResult.observation.observedProjects[0]!.evidence[0]!.locatorKey = "other-invocation";
            },
            (invalid: Fixture) => {
                invalid.input.probeResult.observation.sourceRoots[0]!.locatorEvidence[0]!.locatorKey = "other-root";
            },
            (invalid: Fixture) => {
                invalid.input.probeResult.observation.sourceRoots[0]!.locatorEvidence[0]!.locatorKind = "runtime_known_rule";
            },
            (invalid: Fixture) => {
                invalid.input.probeResult.observation.sourceRoots[0]!.locatorEvidence[0]!.evidenceLevel = "agent_answer";
            },
        ]) {
            const invalid = userSelectedProjectFixture();
            mutate(invalid);
            expect(resolveWithFixture(invalid)).toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_project_binding_missing" }],
            });
        }
    });

    it("requires a usable project-registry resource with trusted locator evidence", () => {
        for (const mutate of [
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.agentRuntimeResources = [];
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.agentRuntimeResources[0]!.accessStatus = "unknown";
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.agentRuntimeResources[0]!.roles = [];
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.agentRuntimeResources[0]!.diagnostics = [
                    testDiagnostic("registry_error", "error"),
                ];
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.agentRuntimeResources[0]!.locatorEvidence = [];
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.agentRuntimeResources[0]!.locatorEvidence[0]!.evidenceLevel =
                    "docs_declared";
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.agentRuntimeResources[0]!.path = "relative";
            },
            (fixture: Fixture) => {
                fixture.input.probeResult.observation.agentRuntimeResources[0]!.path = "/outside/registry.json";
            },
        ]) {
            expectFailure(mutate, "native_guidance_project_binding_missing");
        }
    });

    it("rejects an invalid provider target-schema handshake", () => {
        expectFailure((fixture) => {
            fixture.input.provider.targetContextSchemas = [];
        }, "native_guidance_provider_handshake_invalid");
    });

    it("production resolver rejects a symlinked build-bearing file before consulting conformance", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-observed-target-"));
        try {
            const bin = path.join(root, "bin");
            const project = path.join(root, "project");
            fs.mkdirSync(bin);
            fs.mkdirSync(project);
            const actual = path.join(bin, "actual");
            const link = path.join(bin, "consumer");
            fs.writeFileSync(actual, BUILD_BYTES, { mode: 0o755 });
            fs.symlinkSync(actual, link);
            const fixture = makeFixture({ accessRootPath: root, targetRootPath: project });
            fixture.input.probeResult.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.path = link;
            fixture.input.probeResult.observation.sourceRoots[0]!.path = project;
            const result = resolveObservedNativeProjectGuidanceTargetContext(fixture.input);
            expect(result).toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_build_recheck_failed" }],
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

function resolveWithFixture(fixture: Fixture) {
    return resolveObservedNativeProjectGuidanceTargetContextForTest(fixture.input, fixture.dependencies);
}

function currentTargetCandidate(fixture: Fixture) {
    const candidate = fixture.input.probeResult.observation.targetCandidates[0];
    if (candidate === undefined) throw new Error("target candidate fixture is missing");
    return candidate;
}

function userSelectedProjectFixture(): Fixture {
    const fixture = makeFixture();
    const observation = fixture.input.probeResult.observation;
    const runtime = observation.observedAgentRuntimes[0];
    const root = observation.sourceRoots[0];
    const project = observation.observedProjects[0];
    if (runtime === undefined || root === undefined || project === undefined) {
        throw new Error("Project invocation fixture is incomplete");
    }
    runtime.agentRuntimeResourceIds = [];
    observation.agentRuntimeResources = [];
    project.evidence = [
        {
            evidenceKind: "invocation",
            locatorKey: "probe_project_root",
            evidenceLevel: "user_provided",
        },
    ];
    root.locatorEvidence = [
        {
            locatorKind: "user_provided_path",
            locatorKey: "probe_project_root",
            evidenceLevel: "user_provided",
        },
    ];
    return fixture;
}

function expectFailure(
    mutate: (fixture: Fixture) => void,
    code: string,
    readBuildArtifact?: NativeProjectGuidanceObservationDependenciesForTest["readBuildArtifact"],
    causeKind?: OperationDiagnostic["causeKind"],
): void {
    const fixture = makeFixture();
    mutate(fixture);
    if (readBuildArtifact !== undefined) fixture.dependencies.readBuildArtifact = readBuildArtifact;
    const result = resolveWithFixture(fixture);
    expect(result).toMatchObject({
        status: "failed",
        diagnostics: [{ code, ...(causeKind === undefined ? {} : { causeKind }) }],
    });
}

function stableRead(bytes: Uint8Array, executable: boolean) {
    return {
        bytes: new Uint8Array(bytes),
        executable,
        identity: { deviceId: "1", fileId: "2", entryKind: "file" as const },
    };
}

function testDiagnostic(code: string, severity: OperationDiagnostic["severity"]): OperationDiagnostic {
    return {
        severity,
        code,
        message: code,
        path: "",
        traceId: "",
        operation: "probe",
        causeKind: "invalid_schema",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}
