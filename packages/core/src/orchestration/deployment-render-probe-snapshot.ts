import { physicalAccessPathContains } from "@oaam/shared/paths";
import type { AdapterId, OperationDiagnostic, Platform, PlatformContext, ProbeResult } from "../types";
import { type probeAdapters, validateRegisteredProbeResult } from "./adapter-registry";
import { DeploymentRenderFailure } from "./deployment-render-action-authority";
import type { RenderBaseAuthority } from "./deployment-render-authority";

export interface RenderProbeSnapshotInput {
    readonly base: RenderBaseAuthority;
    readonly ownerAdapterIds: readonly AdapterId[];
    readonly platformContext: PlatformContext;
    readonly probeAdapters: typeof probeAdapters;
    readonly currentProbeResults?: readonly ProbeResult[];
}

export interface RenderProbeSnapshot {
    readonly results: ProbeResult[];
    readonly diagnostics: OperationDiagnostic[];
}

export function selectPlatformContext(
    contexts: PlatformContext[],
    platform: Platform,
    platformInstanceId: string,
    targetRootPath: string,
): PlatformContext {
    const matches = contexts.filter(
        (context) =>
            context.platform === platform &&
            context.platformInstanceId === platformInstanceId &&
            physicalAccessPathContains(context.accessRootPath, targetRootPath),
    );
    if (matches.length !== 1) {
        throw new DeploymentRenderFailure(
            "render.platform_context_ambiguous",
            "Deployment target root must belong to its exact configured platform context",
            "unavailable",
            false,
            [],
        );
    }
    return structuredClone(matches[0] as PlatformContext);
}

export async function resolveRenderProbeSnapshot(input: RenderProbeSnapshotInput): Promise<RenderProbeSnapshot> {
    if (input.currentProbeResults !== undefined) {
        return validateCurrentProbeResults(input.currentProbeResults, input.ownerAdapterIds, input.platformContext);
    }
    const probe = await input.probeAdapters({
        adapterIds: [...input.ownerAdapterIds],
        contexts: [input.platformContext],
        target:
            input.base.projectId === ""
                ? { authorizationScope: "global" }
                : { authorizationScope: "project", projectRootPath: input.base.projectRootPath },
    });
    if (probe.status === "failed") {
        const diagnostic = probe.diagnostics[0] as OperationDiagnostic;
        throw new DeploymentRenderFailure(
            diagnostic.code,
            diagnostic.message,
            diagnostic.causeKind,
            diagnostic.retryable,
            probe.diagnostics,
        );
    }
    return { results: probe.value, diagnostics: probe.diagnostics };
}

function validateCurrentProbeResults(
    source: readonly ProbeResult[],
    ownerAdapterIds: readonly AdapterId[],
    platformContext: PlatformContext,
): RenderProbeSnapshot {
    const results = structuredClone([...source]);
    const expectedOwners = new Set(ownerAdapterIds);
    const seenOwners = new Set<AdapterId>();
    const seenOperationOwners = new Set<AdapterId>();
    const selected: ProbeResult[] = [];
    const invalid = (message: string, diagnostics: OperationDiagnostic[] = []): never => {
        throw new DeploymentRenderFailure("asset_usage.probe_snapshot_invalid", message, "invalid_schema", false, diagnostics);
    };
    for (const result of results) {
        const adapterId = result.observation.adapterId;
        if (seenOperationOwners.has(adapterId)) invalid("asset usage probe operation repeats one Provider");
        seenOperationOwners.add(adapterId);
        const observedContext = result.observation.platformContext;
        if (
            observedContext.platform !== platformContext.platform ||
            observedContext.platformInstanceId !== platformContext.platformInstanceId ||
            observedContext.accessRootPath !== platformContext.accessRootPath
        ) {
            invalid("asset usage probe result does not match the exact selected environment");
        }
        const diagnostics = validateRegisteredProbeResult(result);
        if (diagnostics.length > 0) {
            invalid(
                "asset usage probe result is not a valid registered Provider observation",
                expectedOwners.has(adapterId) ? diagnostics : [],
            );
        }
        if (!expectedOwners.has(adapterId)) continue;
        seenOwners.add(adapterId);
        selected.push(result);
    }
    if (seenOwners.size !== expectedOwners.size) {
        invalid("asset usage probe results are incomplete for the exact selected target Providers");
    }
    return { results: selected, diagnostics: selected.flatMap((result) => result.diagnostics) };
}
