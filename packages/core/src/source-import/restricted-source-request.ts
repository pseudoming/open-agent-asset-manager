/** Private source requests carry declared read authority, never Host State paths or arbitrary filesystem commands. */
import { createSelectedWslPathProjection } from "@oaam/shared/paths";
import { validateAdapterProbeResult } from "../adapters/adapter-probe-validator";
import { sameProbePlatformContext } from "../adapters/probe-context-identity";
import { ROOT_LOCATOR_KINDS, ROOT_ROLES, SOURCE_DOMAINS, SOURCE_EVIDENCE_LEVELS } from "../adapters/adapter-validation-helpers";
import { DEFAULT_ADAPTER_READ_OPERATION_LIMITS } from "../adapters/adapter-read-budget";
import { hasExactKeys, isCanonicalRelativePath, isSha256Digest, isUuidV4 } from "../foundation/validators";
import { BUILTIN_ASSET_KINDS } from "../specs/registry";
import { isRestrictedSourceDiagnostics } from "./restricted-source-diagnostics";
import type { AdapterProvider, AdapterReadTarget, ManagedTargetReadGuard, PlatformContext, SourceRoot } from "../types";
import type { AdapterReadAuthorityContext } from "./source-read-execution";
import type { RestrictedReadAuthorityIntent } from "./restricted-source-read-operation";
import { isRestrictedReadAuthorityPermission, type RestrictedSourceReadContinuation } from "./restricted-source-read-run";

export interface RestrictedSourceSession {
    hostInstanceId: string;
    sessionId: string;
    platformContext: PlatformContext;
}
import { isValidReadAgentRuntimeSelection } from "./source-read-runtime-selection";

export type RestrictedSourceAuthority = Omit<AdapterReadAuthorityContext, "transactionsRoot">;
/** This value is only compared by the injected gate; it is never a Linux lock directory. */
export const RESTRICTED_SOURCE_HOST_LOCK_AUTHORITY = "host-owned-physical-authority";

export function cloneRestrictedSourceSession(input: RestrictedSourceSession): RestrictedSourceSession {
    if (!isUuidV4(input.hostInstanceId) || !isUuidV4(input.sessionId) || !isRestrictedSourceContext(input.platformContext))
        throw new Error("invalid restricted source session");
    createSelectedWslPathProjection(input.platformContext.platformInstanceId, input.platformContext.accessRootPath);
    return structuredClone({
        hostInstanceId: input.hostInstanceId,
        sessionId: input.sessionId,
        platformContext: input.platformContext,
    });
}

export function decodeRestrictedSourceTarget(
    value: unknown,
    provider: AdapterProvider,
    expected: PlatformContext,
): AdapterReadTarget | null {
    try {
        const target = value as AdapterReadTarget;
        if (
            !hasExactKeys(target, [
                "adapterId",
                "sourceSelector",
                ...(target.allowedKinds === undefined ? [] : ["allowedKinds"]),
                ...(target.agentRuntimeIds === undefined ? [] : ["agentRuntimeIds"]),
            ]) ||
            target.adapterId !== provider.adapterId ||
            (target.allowedKinds !== undefined &&
                (!Array.isArray(target.allowedKinds) ||
                    new Set(target.allowedKinds).size !== target.allowedKinds.length ||
                    target.allowedKinds.some((kind) => !BUILTIN_ASSET_KINDS.includes(kind))))
        )
            return null;
        const selector = target.sourceSelector;
        const projection = createSelectedWslPathProjection(expected.platformInstanceId, expected.accessRootPath);
        if (selector.selectorKind === "user_selected_root") {
            if (
                !hasExactKeys(selector, ["selectorKind", "platformContext", "binding"]) ||
                !isRestrictedSourceContext(selector.platformContext) ||
                !sameProbePlatformContext(selector.platformContext, expected) ||
                !hasExactKeys(selector.binding, ["sourceRoot", "assetScope", "projectRootPath"]) ||
                !isRestrictedSourceRoot(selector.binding.sourceRoot) ||
                !["global", "project"].includes(selector.binding.assetScope)
            )
                return null;
            projection.toExecution(selector.binding.sourceRoot.path);
            if (selector.binding.assetScope === "project") projection.toExecution(selector.binding.projectRootPath);
            else if (selector.binding.projectRootPath !== "") return null;
        } else if (selector.selectorKind === "probe_roots") {
            const observation = selector.observation;
            if (
                !hasExactKeys(selector, ["selectorKind", "observation", "sourceRootIds"]) ||
                !hasExactKeys(observation, [
                    "adapterId",
                    "platformContext",
                    "observedAgentRuntimes",
                    "sourceRoots",
                    "agentRuntimeResources",
                    "observedProjects",
                    "targetCandidates",
                    ...(observation.environmentReferences === undefined ? [] : ["environmentReferences"]),
                ]) ||
                observation.adapterId !== provider.adapterId ||
                !isRestrictedSourceContext(observation.platformContext) ||
                !sameProbePlatformContext(observation.platformContext, expected) ||
                !Array.isArray(selector.sourceRootIds) ||
                !selector.sourceRootIds.every(nonBlank) ||
                new Set(selector.sourceRootIds).size !== selector.sourceRootIds.length ||
                !Array.isArray(observation.sourceRoots) ||
                !observation.sourceRoots.every(isRestrictedSourceRoot)
            )
                return null;
            // Preserve the original Provider-owned observation and opaque locator keys.
            if (validateAdapterProbeResult(provider, { status: "partial", observation, diagnostics: [] }, expected).length > 0)
                return null;
            for (const root of observation.sourceRoots) projection.toExecution(root.path);
        } else return null;
        if (!isValidReadAgentRuntimeSelection(provider, target)) return null;
        return structuredClone(target);
    } catch {
        return null;
    }
}

export function decodeRestrictedSourceAuthority(value: unknown): RestrictedSourceAuthority | null {
    if (!hasExactKeys(value, ["managedTargetGuards", "reservationIdentityFingerprints"])) return null;
    const authority = value as RestrictedSourceAuthority;
    if (
        !Array.isArray(authority.managedTargetGuards) ||
        !authority.managedTargetGuards.every(isRestrictedSourceGuard) ||
        !Array.isArray(authority.reservationIdentityFingerprints) ||
        !authority.reservationIdentityFingerprints.every(isSha256Digest) ||
        new Set(authority.reservationIdentityFingerprints).size !== authority.reservationIdentityFingerprints.length
    )
        return null;
    return structuredClone(authority);
}

export function decodeRestrictedReadAuthorityIntent(value: unknown): RestrictedReadAuthorityIntent | null {
    if (!hasExactKeys(value, ["phase", "targets"])) return null;
    const intent = value as RestrictedReadAuthorityIntent;
    if (
        !["access", "final_validate"].includes(intent.phase) ||
        !Array.isArray(intent.targets) ||
        (intent.phase === "access" && intent.targets.length !== 1) ||
        intent.targets.length >
            DEFAULT_ADAPTER_READ_OPERATION_LIMITS.maxReadFiles + DEFAULT_ADAPTER_READ_OPERATION_LIMITS.maxListedDirectories ||
        intent.targets.some(
            (target) =>
                !hasExactKeys(target, ["sourceRootId", "relativePath", "entryKind"]) ||
                !nonBlank(target.sourceRootId) ||
                (target.relativePath !== "" && !isCanonicalRelativePath(target.relativePath)) ||
                !["file", "directory"].includes(target.entryKind),
        )
    )
        return null;
    return structuredClone(intent);
}

export function decodeRestrictedSourceContinuation(value: unknown): RestrictedSourceReadContinuation | null {
    const continuation = value as RestrictedSourceReadContinuation;
    if (continuation === null || typeof continuation !== "object" || !isUuidV4(continuation.stepId)) return null;
    if (
        hasExactKeys(continuation, ["stepId", "intentFingerprint", "permission"]) &&
        "permission" in continuation &&
        isSha256Digest(continuation.intentFingerprint) &&
        isRestrictedReadAuthorityPermission(continuation.permission)
    )
        return structuredClone(continuation);
    if (hasExactKeys(continuation, ["stepId", "released"]) && "released" in continuation && continuation.released === true)
        return structuredClone(continuation);
    return null;
}

function isRestrictedSourceContext(value: unknown): value is PlatformContext {
    if (!hasExactKeys(value, ["platform", "platformInstanceId", "accessRootPath"])) return false;
    const context = value as PlatformContext;
    return context.platform === "wsl" && nonBlank(context.platformInstanceId) && nonBlank(context.accessRootPath);
}

function isRestrictedSourceRoot(value: unknown): value is SourceRoot {
    if (
        !hasExactKeys(value, [
            "sourceRootId",
            "rootRole",
            "sourceDomain",
            "path",
            "accessStatus",
            "locatorEvidence",
            "diagnostics",
        ])
    )
        return false;
    const root = value as SourceRoot;
    return (
        nonBlank(root.sourceRootId) &&
        nonBlank(root.path) &&
        ROOT_ROLES.has(root.rootRole) &&
        SOURCE_DOMAINS.has(root.sourceDomain) &&
        ["available", "not_found", "needs_permission", "unknown"].includes(root.accessStatus) &&
        isRestrictedSourceDiagnostics(root.diagnostics) &&
        Array.isArray(root.locatorEvidence) &&
        root.locatorEvidence.every(
            (evidence) =>
                hasExactKeys(evidence, ["locatorKind", "locatorKey", "evidenceLevel"]) &&
                ROOT_LOCATOR_KINDS.has(evidence.locatorKind) &&
                nonBlank(evidence.locatorKey) &&
                SOURCE_EVIDENCE_LEVELS.has(evidence.evidenceLevel),
        )
    );
}

function isRestrictedSourceGuard(value: unknown): value is ManagedTargetReadGuard {
    if (value === null || typeof value !== "object") return false;
    const guard = value as ManagedTargetReadGuard;
    if (
        !nonBlank(guard.sourceRootId) ||
        !isUuidV4(guard.deploymentId) ||
        !["entire_root", "exact_file", "directory_prefix"].includes(guard.matchKind) ||
        !["active_managed", "residual_managed", "in_flight_managed"].includes(guard.managementState)
    )
        return false;
    const fingerprintKey =
        guard.managementState === "in_flight_managed"
            ? "reservationIdentityFingerprint"
            : guard.matchKind === "exact_file"
              ? "appliedContentHash"
              : "outputUnitFingerprint";
    const record = value as Record<string, unknown>;
    return (
        hasExactKeys(guard, [
            "sourceRootId",
            "matchKind",
            "managementState",
            "deploymentId",
            fingerprintKey,
            ...(guard.matchKind === "entire_root" ? [] : ["relativePath"]),
        ]) &&
        isSha256Digest(record[fingerprintKey]) &&
        (guard.matchKind === "entire_root" || isCanonicalRelativePath(guard.relativePath))
    );
}

function nonBlank(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes("\0");
}
