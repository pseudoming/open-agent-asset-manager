/** Observed installation/project evidence resolution for native project targets. */

import { SafeFilesystemError } from "@oaam/shared/filesystem";
import { physicalAccessPathContains, type snapshotPlatformContextRegularFileNoFollowBounded } from "@oaam/shared/paths";
import type { TargetAgentRuntimeRenderContext } from "../contracts/render";
import type { AdapterProviderSummary, ProbeResult, SourceEvidenceLevel } from "../contracts/source-import";
import { computeTargetApplicabilityFingerprint, stableStringify } from "../foundation/fingerprint";
import { isCanonicalTargetRootPath } from "../foundation/validators";
import type { AgentRuntimeId, Platform, Sha256Digest } from "../types";
import type {
    NativeProjectGuidanceObservationDependenciesForTest,
    ObservedNativeProjectGuidanceTargetContextResolution,
    ResolveObservedNativeProjectGuidanceTargetContextInput,
    VerifiedNativeProjectGuidanceBuild,
} from "./native-project-guidance-profiles";
import {
    compareUtf8Bytes,
    declarationAcceptsTargetKind,
    findNativeProjectGuidanceDeclaration,
    orderedRequiredFacts,
    PLATFORM_FACT_KEY,
    PROJECT_BINDING_FACT_KEY,
    requireProfile,
    requireVerifiedBuild,
    TARGET_KIND_FACT_KEY,
} from "./native-project-guidance-profiles";
import {
    observedTargetFailure,
    type ReadyObservedTargetCandidate,
    resolveReadyObservedTargetCandidate,
} from "./native-project-target-authority";
import {
    operationLocalBuildArtifactObserverAsync,
    operationLocalTestBuildArtifactObserver,
    platformContextBuildArtifactObserver,
} from "./native-project-target-build-observation";
import { targetContextBuild, type VerifiedNativeProjectTargetContextBuild } from "./native-project-target-context-build";
import {
    findObservedProjectBindingEvidence,
    isBuildBearingFileEvidence,
    requiresExecutableMode,
    trustedBuildEvidence,
} from "./native-project-target-evidence";
import type {
    StableBuildArtifactObservation,
    TargetCheckObservationSnapshot,
} from "./native-project-target-observation-snapshot";
import { resolveTargetBuildCompatibility } from "./target-build-compatibility";

interface NativeProjectTargetContextObservationDependencies {
    verifiedBuilds: readonly VerifiedNativeProjectTargetContextBuild[];
    observeBuildArtifact(filePath: string): StableBuildArtifactObservation;
}

interface NativeProjectTargetContextBuildPreflight {
    readonly observation: ProbeResult["observation"];
    readonly platform: Platform;
    readonly runtime: ProbeResult["observation"]["observedAgentRuntimes"][number];
    readonly buildEvidence: readonly (ProbeResult["observation"]["observedAgentRuntimes"][number]["installationEvidence"][number] & {
        readonly kind: "executable" | "launcher" | "app_bundle";
    })[];
    readonly firstBuildEvidence: ProbeResult["observation"]["observedAgentRuntimes"][number]["installationEvidence"][number] & {
        readonly kind: "executable" | "launcher" | "app_bundle";
    };
}

export function findVerifiedNativeProjectGuidanceBuildForTest(input: {
    provider: AdapterProviderSummary;
    agentRuntimeId: AgentRuntimeId;
    buildIdentity: Sha256Digest;
    platform: Platform;
}): Readonly<VerifiedNativeProjectGuidanceBuild> | null {
    return (
        findNativeProjectGuidanceDeclaration(input.provider, input.agentRuntimeId).verifiedBuilds.find(
            (build) =>
                build.agentRuntimeId === input.agentRuntimeId &&
                build.buildIdentity === input.buildIdentity &&
                build.platform === input.platform,
        ) ?? null
    );
}

/** Test-only context factory; production must use resolveObservedNativeProjectGuidanceTargetContext. */
export function makeVerifiedNativeProjectGuidanceTargetContextForTest(input: {
    provider: AdapterProviderSummary;
    build: Readonly<VerifiedNativeProjectGuidanceBuild>;
}): TargetAgentRuntimeRenderContext {
    const declaration = findNativeProjectGuidanceDeclaration(input.provider, input.build.agentRuntimeId);
    const build = requireVerifiedBuild(input.build, declaration.verifiedBuilds);
    return makeNativeProjectGuidanceTargetContext(input.provider, build, () => "agent_runtime_verified");
}

/**
 * Bind an exact consumer build and project root to one current probe snapshot.
 *
 * Static adapter capability is deliberately insufficient here. Every trusted
 * build-bearing file is re-opened no-follow and hashed on every resolution,
 * so an updater that replaces bytes after probe cannot inherit an older
 * conformance row.
 */
export function resolveObservedNativeProjectGuidanceTargetContext(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
): ObservedNativeProjectGuidanceTargetContextResolution {
    return resolveObservedNativeProjectGuidanceTargetContextWithSnapshot(input);
}

function resolveObservedNativeProjectGuidanceTargetContextWithSnapshot(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    snapshot?: TargetCheckObservationSnapshot,
): ObservedNativeProjectGuidanceTargetContextResolution {
    const target = resolveReadyObservedTargetCandidate(input);
    if (target.status === "failed") return target;
    try {
        const declaration = findNativeProjectGuidanceDeclaration(input.provider, input.agentRuntimeId);
        if (!declarationAcceptsTargetKind(declaration, target.candidate.targetKind)) {
            throw new Error("native Guidance declaration does not accept the observed physical target kind");
        }
        return resolveObservedNativeProjectTargetContextCore(
            input,
            {
                verifiedBuilds: collectCompatibleTargetContextBuilds(input.provider, declaration),
                observeBuildArtifact: platformContextBuildArtifactObserver(input, target.candidate, snapshot),
            },
            target.candidate,
        );
    } catch (error) {
        return observedTargetFailure(
            "native_guidance_provider_declaration_invalid",
            `The provider has no unique native Guidance declaration: ${String(error)}`,
            "invalid_schema",
        );
    }
}

/**
 * Resolve the one consumer-runtime target context shared by that runtime's native declarations.
 *
 * Guidance remains a supported declaration kind, but it is not a mandatory anchor: an exact-file-only
 * runtime entry must be callable when all of its declarations share one exact schema/fact authority.
 */
export function resolveObservedNativeProjectTargetContext(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
): ObservedNativeProjectGuidanceTargetContextResolution {
    return resolveObservedNativeProjectTargetContextWithSnapshot(input);
}

/** @internal Same-operation target-check resolver; not part of the Core public surface. */
export function resolveObservedNativeProjectTargetContextWithSnapshot(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    snapshot?: TargetCheckObservationSnapshot,
): ObservedNativeProjectGuidanceTargetContextResolution {
    const target = resolveReadyObservedTargetCandidate(input);
    if (target.status === "failed") return target;
    try {
        const declaration = findNativeProjectTargetContextAnchor(
            input.provider,
            input.agentRuntimeId,
            target.candidate.targetKind,
            targetOwnershipScope(input.projectRootPath),
            input.targetContextSchemaIds,
        );
        return resolveObservedNativeProjectTargetContextCore(
            input,
            {
                verifiedBuilds: collectCompatibleTargetContextBuilds(input.provider, declaration),
                observeBuildArtifact: platformContextBuildArtifactObserver(input, target.candidate, snapshot),
            },
            target.candidate,
        );
    } catch (error) {
        return observedTargetFailure(
            "native_guidance_provider_declaration_invalid",
            `The provider has no unique native project target-context authority: ${String(error)}`,
            "invalid_schema",
        );
    }
}

/** @internal Bounded async resolver used by read-only target checks and action-time render preparation. */
export async function resolveObservedNativeProjectTargetContextAsyncWithSnapshot(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    snapshot?: TargetCheckObservationSnapshot,
    snapshotRegularFile?: typeof snapshotPlatformContextRegularFileNoFollowBounded,
): Promise<ObservedNativeProjectGuidanceTargetContextResolution> {
    const target = resolveReadyObservedTargetCandidate(input);
    if (target.status === "failed") return target;
    try {
        const declaration = findNativeProjectTargetContextAnchor(
            input.provider,
            input.agentRuntimeId,
            target.candidate.targetKind,
            targetOwnershipScope(input.projectRootPath),
            input.targetContextSchemaIds,
        );
        const verifiedBuilds = collectCompatibleTargetContextBuilds(input.provider, declaration);
        const preflight = preflightNativeProjectTargetContextBuild(input, { verifiedBuilds });
        if (preflight.status === "failed") return preflight;
        const observeBuildArtifact = operationLocalBuildArtifactObserverAsync(
            input,
            target.candidate,
            snapshot,
            snapshotRegularFile,
        );
        const observations = await Promise.all(
            preflight.buildEvidence.map(async (evidence) => {
                try {
                    return { path: evidence.path, status: "complete" as const, value: await observeBuildArtifact(evidence.path) };
                } catch (error) {
                    return { path: evidence.path, status: "failed" as const, error };
                }
            }),
        );
        const observationsByPath = new Map(observations.map((observation) => [observation.path, observation]));
        return resolveObservedNativeProjectTargetContextAfterBuildPreflight(
            input,
            {
                verifiedBuilds,
                observeBuildArtifact(filePath) {
                    const observation = observationsByPath.get(filePath) as (typeof observations)[number];
                    if (observation.status === "complete") return observation.value;
                    throw observation.error;
                },
            },
            target.candidate,
            preflight,
        );
    } catch (error) {
        return observedTargetFailure(
            "native_guidance_provider_declaration_invalid",
            `The provider has no unique native project target-context authority: ${String(error)}`,
            "invalid_schema",
        );
    }
}

/** Test-only exact-build/filesystem seam; architecture tests forbid production imports. */
export function resolveObservedNativeProjectGuidanceTargetContextForTest(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    dependencies: NativeProjectGuidanceObservationDependenciesForTest,
    snapshot?: TargetCheckObservationSnapshot,
): ObservedNativeProjectGuidanceTargetContextResolution {
    return resolveObservedNativeProjectGuidanceTargetContextCore(input, dependencies, snapshot);
}

/** Test-only generic target-context seam; architecture tests forbid production imports. */
export function resolveObservedNativeProjectTargetContextForTest(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    dependencies: NativeProjectGuidanceObservationDependenciesForTest,
    snapshot?: TargetCheckObservationSnapshot,
): ObservedNativeProjectGuidanceTargetContextResolution {
    const target = resolveReadyObservedTargetCandidate(input);
    if (target.status === "failed") return target;
    try {
        const declaration = findNativeProjectTargetContextAnchor(
            input.provider,
            input.agentRuntimeId,
            target.candidate.targetKind,
            targetOwnershipScope(input.projectRootPath),
            input.targetContextSchemaIds,
        );
        return resolveObservedNativeProjectTargetContextCore(
            input,
            {
                verifiedBuilds: dependencies.verifiedBuilds.map((build) =>
                    targetContextBuild(declaration, build, dependencies.verifiedBuilds),
                ),
                observeBuildArtifact: operationLocalTestBuildArtifactObserver(input, target.candidate, dependencies, snapshot),
            },
            target.candidate,
        );
    } catch (error) {
        return observedTargetFailure(
            "native_guidance_provider_declaration_invalid",
            `The provider has no unique native project target-context authority: ${String(error)}`,
            "invalid_schema",
        );
    }
}

export function resolveObservedNativeProjectGuidanceTargetContextCore(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    dependencies: NativeProjectGuidanceObservationDependenciesForTest,
    snapshot?: TargetCheckObservationSnapshot,
): ObservedNativeProjectGuidanceTargetContextResolution {
    const target = resolveReadyObservedTargetCandidate(input);
    if (target.status === "failed") return target;
    const declaration = findNativeProjectGuidanceDeclaration(input.provider, input.agentRuntimeId);
    if (!declarationAcceptsTargetKind(declaration, target.candidate.targetKind)) {
        return observedTargetFailure(
            "native_guidance_provider_declaration_invalid",
            "The native Guidance declaration does not accept the observed physical target kind",
            "invalid_schema",
        );
    }
    return resolveObservedNativeProjectTargetContextCore(
        input,
        {
            verifiedBuilds: dependencies.verifiedBuilds.map((build) =>
                targetContextBuild(declaration, build, dependencies.verifiedBuilds),
            ),
            observeBuildArtifact: operationLocalTestBuildArtifactObserver(input, target.candidate, dependencies, snapshot),
        },
        target.candidate,
    );
}

function resolveObservedNativeProjectTargetContextCore(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    dependencies: NativeProjectTargetContextObservationDependencies,
    targetCandidate: ReadyObservedTargetCandidate,
): ObservedNativeProjectGuidanceTargetContextResolution {
    const preflight = preflightNativeProjectTargetContextBuild(input, dependencies);
    if (preflight.status === "failed") return preflight;
    return resolveObservedNativeProjectTargetContextAfterBuildPreflight(input, dependencies, targetCandidate, preflight);
}

function preflightNativeProjectTargetContextBuild(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    dependencies: Pick<NativeProjectTargetContextObservationDependencies, "verifiedBuilds">,
):
    | ({ readonly status: "complete" } & NativeProjectTargetContextBuildPreflight)
    | Extract<ObservedNativeProjectGuidanceTargetContextResolution, { readonly status: "failed" }> {
    const observation = input.probeResult.observation;
    if (observation.adapterId !== input.provider.adapterId) {
        return observedTargetFailure(
            "native_guidance_probe_owner_mismatch",
            "The probe snapshot and provider registry have different owners",
            "invalid_schema",
        );
    }
    const platform = observation.platformContext.platform;
    const accessRootPath = observation.platformContext.accessRootPath;
    const matchingRuntimes = observation.observedAgentRuntimes.filter(
        (runtime) => runtime.agentRuntimeId === input.agentRuntimeId,
    );
    if (matchingRuntimes.length !== 1) {
        return observedTargetFailure(
            "native_guidance_runtime_observation_invalid",
            "The probe snapshot must contain exactly one selected agent-runtime entry",
            "invalid_schema",
        );
    }
    const runtime = matchingRuntimes[0] as (typeof matchingRuntimes)[number];
    if (runtime.installationStatus !== "available" || runtime.diagnostics.some((item) => item.severity === "error")) {
        return observedTargetFailure(
            "native_guidance_runtime_unavailable",
            "The selected agent-runtime entry lacks complete installation/project evidence",
            "unavailable",
        );
    }
    if (!input.provider.agentRuntimes.some((descriptor) => descriptor.agentRuntimeId === input.agentRuntimeId)) {
        return observedTargetFailure(
            "native_guidance_runtime_owner_mismatch",
            "The selected agent-runtime entry is not owned by the provider registry",
            "invalid_schema",
        );
    }

    const buildEvidence = runtime.installationEvidence.filter(isBuildBearingFileEvidence);
    const firstBuildEvidence = buildEvidence[0];
    if (
        firstBuildEvidence === undefined ||
        new Set(buildEvidence.map((evidence) => evidence.path)).size !== buildEvidence.length
    ) {
        return observedTargetFailure(
            "native_guidance_build_evidence_invalid",
            "The selected agent-runtime entry must identify distinct build-bearing files",
            "invalid_schema",
        );
    }
    if (
        dependencies.verifiedBuilds.some((build) => {
            const anchorKeys = build.compatibilityAnchors.map((anchor) =>
                [anchor.agentRuntimeId, anchor.versionText, anchor.buildIdentity, anchor.platform].join("\0"),
            );
            return new Set(anchorKeys).size !== anchorKeys.length;
        })
    ) {
        return observedTargetFailure(
            "native_guidance_build_catalog_ambiguous",
            "The target build catalog contains duplicate conformance anchors",
            "internal_error",
            firstBuildEvidence.path,
        );
    }
    for (const evidence of buildEvidence) {
        if (
            !trustedBuildEvidence(evidence.evidenceLevel) ||
            evidence.diagnostics.some((item) => item.severity === "error") ||
            !isCanonicalTargetRootPath(evidence.path, platform) ||
            !physicalAccessPathContains(accessRootPath, evidence.path)
        ) {
            return observedTargetFailure(
                "native_guidance_build_evidence_untrusted",
                "Build-bearing evidence is unchecked, non-canonical or outside the probed platform root",
                "verification_failed",
                evidence.path,
            );
        }
    }
    return { status: "complete", observation, platform, runtime, buildEvidence, firstBuildEvidence };
}

function resolveObservedNativeProjectTargetContextAfterBuildPreflight(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    dependencies: NativeProjectTargetContextObservationDependencies,
    targetCandidate: ReadyObservedTargetCandidate,
    preflight: NativeProjectTargetContextBuildPreflight,
): ObservedNativeProjectGuidanceTargetContextResolution {
    const { observation, platform, runtime, buildEvidence, firstBuildEvidence } = preflight;
    const matchingEvidenceAndBuilds = new Map<
        string,
        {
            evidence: (typeof buildEvidence)[number];
            build: VerifiedNativeProjectTargetContextBuild;
        }
    >();
    const exactOnlyVersionMismatches = new Set<string>();
    for (const evidence of buildEvidence) {
        let sample: StableBuildArtifactObservation;
        try {
            sample = dependencies.observeBuildArtifact(evidence.path);
        } catch (error) {
            return observedTargetFailure(
                "native_guidance_build_recheck_failed",
                error instanceof SafeFilesystemError
                    ? `Build-bearing file recheck failed closed: ${error.failureKind}`
                    : "Build-bearing file recheck failed closed with an unexpected error",
                error instanceof SafeFilesystemError && error.failureKind === "permission_denied"
                    ? "permission_denied"
                    : "verification_failed",
                evidence.path,
            );
        }
        if (platform !== "win32" && requiresExecutableMode(evidence) && !sample.executable) {
            return observedTargetFailure(
                "native_guidance_build_mode_invalid",
                "The observed executable or launcher is no longer executable",
                "verification_failed",
                evidence.path,
            );
        }

        const buildIdentity = sample.buildIdentity;
        for (const build of dependencies.verifiedBuilds) {
            if (
                build.buildCompatibility === undefined &&
                build.agentRuntimeId === input.agentRuntimeId &&
                build.buildIdentity === buildIdentity &&
                build.platform === platform &&
                runtime.versionText !== "" &&
                runtime.versionText !== build.versionText
            ) {
                exactOnlyVersionMismatches.add(
                    [
                        evidence.path,
                        build.agentRuntimeId,
                        build.versionText,
                        build.buildIdentity,
                        build.platform,
                        build.targetContextSchemaId,
                        stableStringify(build.requiredFacts),
                    ].join("\0"),
                );
            }
            const observedVersionText =
                runtime.versionText === "" && build.buildIdentity === buildIdentity ? build.versionText : runtime.versionText;
            const resolution = resolveTargetBuildCompatibility({
                anchors: build.compatibilityAnchors,
                policy: build.buildCompatibility,
                current: {
                    agentRuntimeId: input.agentRuntimeId,
                    versionText: observedVersionText,
                    buildIdentity,
                    platform,
                },
            });
            if (
                resolution.status === "blocked" ||
                resolution.anchor.agentRuntimeId !== build.agentRuntimeId ||
                resolution.anchor.versionText !== build.versionText ||
                resolution.anchor.buildIdentity !== build.buildIdentity ||
                resolution.anchor.platform !== build.platform
            ) {
                continue;
            }
            const currentBuild: VerifiedNativeProjectTargetContextBuild = {
                ...build,
                versionText: observedVersionText,
                buildIdentity,
            };
            const key = [
                evidence.path,
                currentBuild.agentRuntimeId,
                currentBuild.versionText,
                currentBuild.buildIdentity,
                currentBuild.platform,
                currentBuild.targetContextSchemaId,
                stableStringify(currentBuild.requiredFacts),
            ].join("\0");
            matchingEvidenceAndBuilds.set(key, { evidence, build: currentBuild });
        }
    }
    const matches = [...matchingEvidenceAndBuilds.values()];
    if (matches.length === 0) {
        if (exactOnlyVersionMismatches.size > 1) {
            return observedTargetFailure(
                "native_guidance_build_catalog_ambiguous",
                "Build-bearing evidence matches more than one exact-only conformance row with a conflicting version",
                "internal_error",
                firstBuildEvidence.path,
            );
        }
        if (exactOnlyVersionMismatches.size === 1) {
            return observedTargetFailure(
                "native_guidance_version_mismatch",
                "The observed version text does not match the exact consumer build",
                "version_incompatible",
                firstBuildEvidence.path,
            );
        }
        return observedTargetFailure(
            "native_guidance_build_unverified",
            "No current build-bearing file is accepted by an exact or Provider-declared compatible conformance row",
            "version_incompatible",
            firstBuildEvidence.path,
        );
    }
    if (matches.length !== 1) {
        return observedTargetFailure(
            "native_guidance_build_catalog_ambiguous",
            "Build-bearing evidence and the target build catalog do not resolve to one unique current context",
            "internal_error",
            firstBuildEvidence.path,
        );
    }
    const { build } = matches[0] as (typeof matches)[number];

    const requiresProjectBinding = Object.hasOwn(build.requiredFacts, PROJECT_BINDING_FACT_KEY);
    if (requiresProjectBinding && runtime.projectDiscoveryStatus !== "complete") {
        return observedTargetFailure(
            "native_guidance_runtime_unavailable",
            "The selected agent-runtime entry lacks complete Project evidence required by this target",
            "unavailable",
        );
    }
    const projectEvidenceLevel = requiresProjectBinding
        ? findObservedProjectBindingEvidence(
              observation,
              runtime.observedProjectIds,
              runtime.sourceRootIds,
              runtime.agentRuntimeResourceIds,
              input.projectRootPath,
          )
        : null;
    if (requiresProjectBinding && projectEvidenceLevel === null) {
        return observedTargetFailure(
            "native_guidance_project_binding_missing",
            "The target root is not a usable project bound to the selected agent-runtime entry",
            "verification_failed",
            input.targetRootPath,
        );
    }

    try {
        return {
            status: "complete",
            targetContext: makeNativeProjectTargetContext(input.provider, build, (key) => {
                if (key === PROJECT_BINDING_FACT_KEY && projectEvidenceLevel !== null) return projectEvidenceLevel;
                if (key === TARGET_KIND_FACT_KEY) return targetCandidate.evidenceLevel;
                return "agent_runtime_verified";
            }),
            diagnostics: [],
        };
    } catch (error) {
        return observedTargetFailure(
            "native_guidance_provider_handshake_invalid",
            `The exact build does not match the provider target declaration: ${String(error)}`,
            "invalid_schema",
        );
    }
}

export function makeNativeProjectGuidanceTargetContext(
    provider: AdapterProviderSummary,
    build: Readonly<VerifiedNativeProjectGuidanceBuild>,
    evidenceLevelForFact: (key: string) => SourceEvidenceLevel,
): TargetAgentRuntimeRenderContext {
    const declaration = findNativeProjectGuidanceDeclaration(provider, build.agentRuntimeId);
    requireVerifiedBuild(build, declaration.verifiedBuilds);
    requireProfile(declaration, build.materializationProfileId);
    return makeNativeProjectTargetContext(provider, targetContextBuild(declaration, build), evidenceLevelForFact);
}

function makeNativeProjectTargetContext(
    provider: AdapterProviderSummary,
    build: Readonly<VerifiedNativeProjectTargetContextBuild>,
    evidenceLevelForFact: (key: string) => SourceEvidenceLevel,
): TargetAgentRuntimeRenderContext {
    const descriptor = provider.agentRuntimes.find((entry) => entry.agentRuntimeId === build.agentRuntimeId);
    const schema = provider.targetContextSchemas.find(
        (entry) => entry.agentRuntimeId === build.agentRuntimeId && entry.targetContextSchemaId === build.targetContextSchemaId,
    );
    if (descriptor === undefined || schema === undefined) {
        throw new Error("verified native target build has no provider target schema");
    }
    const preimage = {
        schemaVersion: 1 as const,
        agentRuntimeId: build.agentRuntimeId,
        versionText: build.versionText,
        buildIdentity: build.buildIdentity,
        targetContextSchemaId: schema.targetContextSchemaId,
        targetContextSchemaFingerprint: schema.schemaFingerprint,
        renderFacts: [
            {
                key: PLATFORM_FACT_KEY,
                value: build.platform,
                evidenceLevel: "agent_runtime_verified" as const,
            },
            ...orderedRequiredFacts(build).map(([key, value]) => ({
                key,
                value,
                evidenceLevel: evidenceLevelForFact(key),
            })),
        ].sort((left, right) => compareUtf8Bytes(left.key, right.key)),
    };
    return {
        ...preimage,
        targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
            context: preimage,
            entryClass: descriptor.entryClass,
        }),
    };
}

function collectCompatibleTargetContextBuilds(
    provider: AdapterProviderSummary,
    targetDeclaration: AdapterProviderSummary["renderContractDeclarations"][number],
): VerifiedNativeProjectTargetContextBuild[] {
    const expectedFacts = stableStringify(targetDeclaration.target.requiredFacts);
    const compatible = provider.renderContractDeclarations.filter(
        (declaration) =>
            declaration.agentRuntimeId === targetDeclaration.agentRuntimeId &&
            declaration.target.targetContextSchemaId === targetDeclaration.target.targetContextSchemaId &&
            stableStringify(declaration.target.requiredFacts) === expectedFacts,
    );
    const builds: VerifiedNativeProjectTargetContextBuild[] = [];
    for (const declaration of compatible) {
        for (const build of declaration.verifiedBuilds) {
            builds.push(targetContextBuild(declaration, build, declaration.verifiedBuilds));
        }
    }
    return builds.sort((left, right) =>
        compareUtf8Bytes(
            [
                left.agentRuntimeId,
                left.versionText,
                left.buildIdentity,
                left.platform,
                left.targetContextSchemaId,
                stableStringify(left.requiredFacts),
                stableStringify(left.buildCompatibility ?? null),
            ].join("\0"),
            [
                right.agentRuntimeId,
                right.versionText,
                right.buildIdentity,
                right.platform,
                right.targetContextSchemaId,
                stableStringify(right.requiredFacts),
                stableStringify(right.buildCompatibility ?? null),
            ].join("\0"),
        ),
    );
}

function findNativeProjectTargetContextAnchor(
    provider: AdapterProviderSummary,
    agentRuntimeId: AgentRuntimeId,
    targetKind: ProbeResult["observation"]["targetCandidates"][number]["targetKind"],
    ownershipScope: "project" | "global",
    targetContextSchemaIds: readonly string[] | undefined,
): AdapterProviderSummary["renderContractDeclarations"][number] {
    const schemaIds = new Set(targetContextSchemaIds ?? []);
    const declarationsForRuntime = provider.renderContractDeclarations
        .filter((declaration) => declaration.agentRuntimeId === agentRuntimeId)
        .filter((declaration) => schemaIds.size === 0 || schemaIds.has(declaration.target.targetContextSchemaId))
        .sort((left, right) =>
            compareUtf8Bytes(
                [left.target.targetContextSchemaId, left.declarationKind, left.outputContractId].join("\0"),
                [right.target.targetContextSchemaId, right.declarationKind, right.outputContractId].join("\0"),
            ),
        );
    if (declarationsForRuntime.length === 0) {
        throw new Error("native project target context requires at least one runtime declaration");
    }
    const requiredScope = targetKind === "project" || targetKind === "global" ? targetKind : ownershipScope;
    const scopeMatched = declarationsForRuntime.filter((declaration) => declarationScope(declaration) === requiredScope);
    const candidates = scopeMatched.length > 0 ? scopeMatched : declarationsForRuntime;
    const exact = candidates.filter((declaration) => declaration.target.requiredFacts[TARGET_KIND_FACT_KEY] === targetKind);
    const declarations =
        exact.length > 0
            ? exact
            : candidates.filter(
                  (declaration) =>
                      declaration.target.requiredFacts[TARGET_KIND_FACT_KEY] === undefined &&
                      declarationAcceptsTargetKind(declaration, targetKind),
              );
    if (declarations.length === 0) {
        throw new Error(`native project target context has no declaration for physical target kind ${targetKind}`);
    }
    const authorities = new Set(
        declarations.map((declaration) =>
            stableStringify({
                targetContextSchemaId: declaration.target.targetContextSchemaId,
                requiredFacts: declaration.target.requiredFacts,
            }),
        ),
    );
    if (authorities.size !== 1) {
        throw new Error("native declarations for the selected target kind do not share one target-context schema and fact set");
    }
    return declarations[0] as AdapterProviderSummary["renderContractDeclarations"][number];
}

function targetOwnershipScope(projectRootPath: string): "project" | "global" {
    return projectRootPath === "" ? "global" : "project";
}

function declarationScope(
    declaration: AdapterProviderSummary["renderContractDeclarations"][number],
): "project" | "global" | null {
    if (declaration.declarationKind.startsWith("native_global_")) return "global";
    if (declaration.declarationKind.startsWith("native_project_")) return "project";
    return null;
}
