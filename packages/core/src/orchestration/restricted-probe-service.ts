/** State-free Provider observation in the selected WSL process. */
import { randomUUID } from "node:crypto";
import { inspectDirectoryNoFollow, samePhysicalPathIdentity } from "@oaam/shared/filesystem";
import {
    createSelectedWslPathProjection,
    withPathEnvironmentObservation,
    type PlatformContextBuildObservationResult,
} from "@oaam/shared/paths";
import { validateAdapterProbeResult } from "../adapters/adapter-probe-validator";
import { sameProbePlatformContext } from "../adapters/probe-context-identity";
import { failedProbeResult, probeExceptionDiagnostic } from "../adapters/probe-failure";
import { hasExactKeys, isUuidV4 } from "../foundation/validators";
import type {
    AdapterProbeContext,
    AdapterProbeResult,
    AdapterProvider,
    OperationDiagnostic,
    PlatformContext,
    ProbeResult,
} from "../types";
import type { SelectedWslProbeExecution } from "./selected-wsl-probe-execution";
import {
    decodeRestrictedBuildObservationResult,
    executeRestrictedBuildObservation,
    restrictedBuildSelectionFingerprint,
    validateRestrictedBuildObservationSelection,
    type RestrictedBuildObservationSelection,
} from "./restricted-build-observation";

export const RESTRICTED_PROBE_PROTOCOL = "oaam.restricted-probe.v1";
export const RESTRICTED_PROBE_MAX_FRAME_BYTES = 12 * 1024 * 1024;

export interface RestrictedProbeSession {
    hostInstanceId: string;
    sessionId: string;
    platformContext: PlatformContext;
}

export interface RestrictedProbeRequest {
    protocol: typeof RESTRICTED_PROBE_PROTOCOL;
    hostInstanceId: string;
    sessionId: string;
    operationId: string;
    sequence: number;
    adapterId: string;
    context: AdapterProbeContext;
}

export interface RestrictedProbeResponse extends Omit<RestrictedProbeRequest, "adapterId" | "context"> {
    result: ProbeResult;
}

export interface RestrictedBuildObservationRequest extends Omit<RestrictedProbeRequest, "adapterId" | "context"> {
    buildObservation: RestrictedBuildObservationSelection;
}
export interface RestrictedBuildObservationResponse extends Omit<RestrictedProbeRequest, "adapterId" | "context"> {
    selectionFingerprint: ReturnType<typeof restrictedBuildSelectionFingerprint>;
    observations: PlatformContextBuildObservationResult;
}
export type RestrictedProbeWireRequest = RestrictedProbeRequest | RestrictedBuildObservationRequest;
export type RestrictedProbeWireResponse = RestrictedProbeResponse | RestrictedBuildObservationResponse;

export function createRestrictedProbeService(
    input: RestrictedProbeSession & {
        providers: readonly AdapterProvider[];
        deadlineAt: number;
    },
) {
    const session = cloneSession(input);
    if (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= Date.now() || input.deadlineAt > Date.now() + 600_000) {
        throw new Error("invalid restricted probe lifetime");
    }
    const deadlineAt = input.deadlineAt;
    const projection = createSelectedWslPathProjection(
        session.platformContext.platformInstanceId,
        session.platformContext.accessRootPath,
    );
    const localContext = { ...session.platformContext, accessRootPath: projection.executionAccessRootPath };
    const providers = new Map(input.providers.map((provider) => [provider.adapterId, provider]));
    if (providers.size === 0 || providers.size !== input.providers.length)
        throw new Error("invalid restricted probe Provider inventory");
    const rootIdentity = inspectDirectoryNoFollow(localContext.accessRootPath);
    const operations = new Set<string>();
    let sequence = 0;
    return Object.freeze({ handle });

    function handle(value: RestrictedProbeRequest): Promise<RestrictedProbeResponse>;
    function handle(value: RestrictedBuildObservationRequest): Promise<RestrictedBuildObservationResponse>;
    function handle(value: unknown): Promise<RestrictedProbeWireResponse>;
    async function handle(value: unknown): Promise<RestrictedProbeWireResponse> {
        const buildRequest = hasExactKeys(value, [
            "protocol",
            "hostInstanceId",
            "sessionId",
            "operationId",
            "sequence",
            "buildObservation",
        ]);
        if (
            !buildRequest &&
            !hasExactKeys(value, ["protocol", "hostInstanceId", "sessionId", "operationId", "sequence", "adapterId", "context"])
        ) {
            throw new Error("invalid restricted probe envelope");
        }
        if (Buffer.byteLength(JSON.stringify(value), "utf8") > RESTRICTED_PROBE_MAX_FRAME_BYTES)
            throw new Error("restricted probe request exceeds limit");
        const request = structuredClone(value) as RestrictedProbeWireRequest;
        if (
            request.protocol !== RESTRICTED_PROBE_PROTOCOL ||
            request.hostInstanceId !== session.hostInstanceId ||
            request.sessionId !== session.sessionId ||
            !isUuidV4(request.operationId) ||
            operations.has(request.operationId) ||
            request.sequence !== sequence + 1 ||
            sequence >= 128 ||
            Date.now() >= deadlineAt
        )
            throw new Error("restricted probe session, operation or sequence mismatch");
        if ("buildObservation" in request) {
            validateRestrictedBuildObservationSelection(request.buildObservation, session.platformContext, providers);
            requireRootIdentity();
            sequence = request.sequence;
            operations.add(request.operationId);
            const observations = await executeRestrictedBuildObservation(session.platformContext, request.buildObservation);
            requireRootIdentity();
            if (Date.now() >= deadlineAt) throw new Error("restricted probe expired during build observation");
            return {
                protocol: RESTRICTED_PROBE_PROTOCOL,
                hostInstanceId: session.hostInstanceId,
                sessionId: session.sessionId,
                operationId: request.operationId,
                sequence: request.sequence,
                selectionFingerprint: restrictedBuildSelectionFingerprint(request.buildObservation),
                observations,
            };
        }
        const provider = providers.get(request.adapterId);
        if (provider === undefined) throw new Error("unapproved restricted probe Provider");
        const context = projectRequestContext(request.context, session.platformContext, projection.toExecution, localContext);
        requireRootIdentity();
        sequence = request.sequence;
        operations.add(request.operationId);
        let result: ProbeResult;
        try {
            const observed = structuredClone(await withPathEnvironmentObservation(() => provider.probe(context)));
            const localDiagnostics = validateAdapterProbeResult(provider, observed, localContext);
            const projected = localDiagnostics.length > 0 ? undefined : projectObservedPaths(observed, projection.toHost);
            const diagnostics =
                localDiagnostics.length > 0
                    ? localDiagnostics
                    : validateAdapterProbeResult(provider, projected!, session.platformContext);
            result =
                diagnostics.length > 0
                    ? failedProbeResult(
                          request.adapterId,
                          session.platformContext,
                          diagnostics.map((diagnostic) => ({ ...diagnostic, operation: "probe" })),
                      )
                    : {
                          ...projected!,
                          observation: {
                              ...projected!.observation,
                              adapterId: request.adapterId,
                              platformContext: structuredClone(session.platformContext),
                          },
                      };
            if (Buffer.byteLength(JSON.stringify(result), "utf8") > RESTRICTED_PROBE_MAX_FRAME_BYTES - 16_384) {
                throw new Error("Provider probe result exceeds the observation limit");
            }
        } catch (error) {
            result = failedProbeResult(request.adapterId, session.platformContext, [
                probeExceptionDiagnostic(request.adapterId, error),
            ]);
        }
        // A normal Provider failure is local to that Provider. Lost root identity
        // or lifetime remains a channel failure, including when the Provider threw.
        requireRootIdentity();
        if (Date.now() >= deadlineAt) throw new Error("restricted probe expired during observation");
        const response: RestrictedProbeResponse = {
            protocol: RESTRICTED_PROBE_PROTOCOL,
            hostInstanceId: session.hostInstanceId,
            sessionId: session.sessionId,
            operationId: request.operationId,
            sequence: request.sequence,
            result,
        };
        if (Buffer.byteLength(JSON.stringify(response), "utf8") > RESTRICTED_PROBE_MAX_FRAME_BYTES)
            throw new Error("restricted probe response exceeds limit");
        return response;
    }

    function requireRootIdentity() {
        if (!samePhysicalPathIdentity(rootIdentity, inspectDirectoryNoFollow(localContext.accessRootPath))) {
            throw new Error("restricted probe access root identity changed");
        }
    }
}

/** The caller validates identity before its registry consumes any Provider observation. */
export function createRestrictedProbeChannel(
    input: RestrictedProbeSession & {
        exchange(request: RestrictedProbeWireRequest): Promise<unknown>;
    },
): Required<SelectedWslProbeExecution> {
    const session = cloneSession(input);
    let sequence = 0;
    let usable = true;
    return Object.freeze({
        async observeBuildArtifacts(source: RestrictedBuildObservationSelection): Promise<PlatformContextBuildObservationResult> {
            try {
                if (!usable || sequence >= 128) throw new Error("restricted probe channel is unavailable");
                const selection = structuredClone(source);
                validateRestrictedBuildObservationSelection(selection, session.platformContext);
                const request: RestrictedBuildObservationRequest = {
                    protocol: RESTRICTED_PROBE_PROTOCOL,
                    hostInstanceId: session.hostInstanceId,
                    sessionId: session.sessionId,
                    operationId: randomUUID(),
                    sequence: ++sequence,
                    buildObservation: selection,
                };
                if (Buffer.byteLength(JSON.stringify(request), "utf8") > RESTRICTED_PROBE_MAX_FRAME_BYTES)
                    throw new Error("restricted build observation request exceeds limit");
                const raw = await input.exchange(request);
                if (
                    !usable ||
                    !hasExactKeys(raw, [
                        "protocol",
                        "hostInstanceId",
                        "sessionId",
                        "operationId",
                        "sequence",
                        "selectionFingerprint",
                        "observations",
                    ])
                )
                    throw new Error("invalid restricted build observation response envelope");
                const response = structuredClone(raw) as RestrictedBuildObservationResponse;
                if (
                    Buffer.byteLength(JSON.stringify(response), "utf8") > RESTRICTED_PROBE_MAX_FRAME_BYTES ||
                    response.protocol !== request.protocol ||
                    response.hostInstanceId !== request.hostInstanceId ||
                    response.sessionId !== request.sessionId ||
                    response.operationId !== request.operationId ||
                    response.sequence !== request.sequence ||
                    response.selectionFingerprint !== restrictedBuildSelectionFingerprint(selection)
                )
                    throw new Error("restricted build observation response identity mismatch");
                return decodeRestrictedBuildObservationResult(response.observations, selection);
            } catch (error) {
                usable = false;
                throw error;
            }
        },
        async probe(adapterId: string, context: AdapterProbeContext): Promise<ProbeResult> {
            try {
                if (!usable || sequence >= 128) throw new Error("restricted probe channel is unavailable");
                if (!sameProbePlatformContext(context.platformContext, session.platformContext))
                    throw new Error("restricted probe channel Environment mismatch");
                const request: RestrictedProbeRequest = {
                    protocol: RESTRICTED_PROBE_PROTOCOL,
                    hostInstanceId: session.hostInstanceId,
                    sessionId: session.sessionId,
                    operationId: randomUUID(),
                    sequence: ++sequence,
                    adapterId,
                    context: structuredClone(context),
                };
                const raw = await input.exchange(request);
                if (!usable) throw new Error("restricted probe channel became unavailable");
                if (!hasExactKeys(raw, ["protocol", "hostInstanceId", "sessionId", "operationId", "sequence", "result"]))
                    throw new Error("invalid restricted probe response envelope");
                const response = structuredClone(raw) as RestrictedProbeResponse;
                if (
                    response.protocol !== request.protocol ||
                    response.hostInstanceId !== request.hostInstanceId ||
                    response.sessionId !== request.sessionId ||
                    response.operationId !== request.operationId ||
                    response.sequence !== request.sequence ||
                    response.result.observation.adapterId !== adapterId ||
                    !sameProbePlatformContext(response.result.observation.platformContext, session.platformContext)
                )
                    throw new Error("restricted probe response identity mismatch");
                return response.result;
            } catch (error) {
                usable = false;
                throw error;
            }
        },
    });
}

function cloneSession(input: RestrictedProbeSession): RestrictedProbeSession {
    if (!isUuidV4(input.hostInstanceId) || !isUuidV4(input.sessionId) || input.platformContext.platform !== "wsl") {
        throw new Error("invalid restricted probe session binding");
    }
    createSelectedWslPathProjection(input.platformContext.platformInstanceId, input.platformContext.accessRootPath);
    return {
        hostInstanceId: input.hostInstanceId,
        sessionId: input.sessionId,
        platformContext: structuredClone(input.platformContext),
    };
}

function projectRequestContext(
    source: AdapterProbeContext,
    expected: PlatformContext,
    toExecution: (value: string) => string,
    localContext: PlatformContext,
): AdapterProbeContext {
    const scopeKeys =
        source?.authorizationScope === "global"
            ? []
            : source?.authorizationScope === "project"
              ? ["projectRootPath"]
              : source?.authorizationScope === "directory"
                ? ["directoryRootPath"]
                : null;
    if (
        scopeKeys === null ||
        !hasExactKeys(source, [
            "authorizationScope",
            "platformContext",
            ...scopeKeys,
            ...(source.installationRootPath === undefined ? [] : ["installationRootPath"]),
        ])
    )
        throw new Error("invalid restricted probe scope");
    if (
        !hasExactKeys(source.platformContext, ["platform", "platformInstanceId", "accessRootPath"]) ||
        !sameProbePlatformContext(source.platformContext, expected)
    )
        throw new Error("restricted probe request Environment mismatch");
    const context = structuredClone(source);
    context.platformContext = { ...localContext };
    if (context.installationRootPath !== undefined) context.installationRootPath = toExecution(context.installationRootPath);
    if (context.authorizationScope === "project") context.projectRootPath = toExecution(context.projectRootPath);
    if (context.authorizationScope === "directory") context.directoryRootPath = toExecution(context.directoryRootPath);
    return context;
}

/** Only contract-owned physical path fields move coordinates; Provider IDs and private strings stay exact. */
function projectObservedPaths(source: AdapterProbeResult, toHost: (value: string) => string): AdapterProbeResult {
    const result = structuredClone(source);
    const diagnostics = (items: OperationDiagnostic[]) => {
        for (const diagnostic of items) {
            // Empty/relative diagnostic labels and all Provider prose retain their original meaning.
            if (diagnostic.path.startsWith("/")) diagnostic.path = toHost(diagnostic.path);
        }
    };
    diagnostics(result.diagnostics);
    for (const entry of result.observation.observedAgentRuntimes) {
        diagnostics(entry.diagnostics);
        for (const evidence of entry.installationEvidence) {
            evidence.path = toHost(evidence.path);
            diagnostics(evidence.diagnostics);
        }
    }
    for (const root of result.observation.sourceRoots) {
        root.path = toHost(root.path);
        diagnostics(root.diagnostics);
    }
    for (const resource of result.observation.agentRuntimeResources) {
        resource.path = toHost(resource.path);
        diagnostics(resource.diagnostics);
    }
    for (const project of result.observation.observedProjects) diagnostics(project.diagnostics);
    for (const target of result.observation.targetCandidates) {
        target.targetRootPath = toHost(target.targetRootPath);
        diagnostics(target.diagnostics);
        for (const applicability of target.entryApplicabilities) diagnostics(applicability.diagnostics);
    }
    return result;
}
