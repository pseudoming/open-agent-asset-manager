/** Bounded OpenCode public project-list discovery for one exact running build. */

import {
    classifyProviderProcessObservationFailure,
    createProviderProbeDeadline,
    probeDiagnostic as diagnostic,
    inspectProviderRegularFileNoFollow,
    listProviderLocalProcessExecutableCandidateIdsBounded,
    observeProviderLocalProcessExecutableBounded,
    type ProviderLocalProcessObservation,
    type ProviderProbeDeadline,
    type ProviderProcessObservationFailure,
    type ProviderRegularFileIdentity,
    remainingProviderProbeDeadlineMilliseconds,
    sameProviderRegularFileIdentity,
} from "@oaam/adapter-framework";
import type { OperationDiagnostic, PlatformContext } from "@oaam/core";
import {
    discoverOpenCodeCompatibilityDatabase,
    type OpenCodeCompatibilityDatabaseResult,
} from "./opencode-probe-compatibility-database";
import { invokeOpenCodeExecutableTreeBounded, type OpenCodeBoundedInvocationResult } from "./opencode-probe-local-invocation";
import { discoverOpenCodeResolvedProfileProjects } from "./opencode-probe-profile-project-discovery";
import { fetchOpenCodeProjectsBounded } from "./opencode-probe-project-list-fetch";
import { type OpenCodeProjectRecord, parseOpenCodeProjectList } from "./opencode-probe-project-payload";
import {
    discoverStoppedOpenCodeProjects,
    type OpenCodeStoppedProjectDiscoveryResult,
} from "./opencode-probe-stopped-project-discovery";

export { fetchOpenCodeProjectsBounded } from "./opencode-probe-project-list-fetch";
export { parseOpenCodeProjectList, type OpenCodeProjectRecord } from "./opencode-probe-project-payload";

const MAXIMUM_PROCESS_IDS = 65_536;
const MAXIMUM_COMMAND_LINE_BYTES = 65_536;
const MAXIMUM_PROJECT_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const MAXIMUM_ATTEMPTS = 3;
const RETRY_DELAY_MILLISECONDS = 3_000;
const TOTAL_DEADLINE_MILLISECONDS = 10_000;
const INVOCATION_TIMEOUT_MILLISECONDS = 1_500;
export interface OpenCodeRunningProjectDiscoveryInput {
    readonly executablePath: string;
    readonly executableIdentity: ProviderRegularFileIdentity;
    readonly environment: NodeJS.ProcessEnv;
    readonly workingDirectory: string;
    readonly platformContext: PlatformContext;
    readonly hostPlatform: NodeJS.Platform;
    readonly diagnosticPath: string;
}

export interface OpenCodeRunningProjectDiscoveryResult {
    readonly status: "complete" | "partial" | "stopped";
    readonly projects: readonly OpenCodeProjectRecord[];
    readonly diagnostics: readonly OperationDiagnostic[];
    readonly processVisibility?: "permission_limited";
}

export interface OpenCodeProjectDiscoveryInput {
    readonly executable: {
        readonly path: string;
        readonly identity: ProviderRegularFileIdentity;
    } | null;
    readonly environment: NodeJS.ProcessEnv;
    readonly workingDirectory: string;
    readonly platformContext: PlatformContext;
    readonly hostPlatform: NodeJS.Platform;
    readonly diagnosticPath: string;
    readonly databasePath: string | null;
}

export interface OpenCodeProjectDiscoveryResult {
    readonly status: "complete" | "partial";
    readonly projects: readonly OpenCodeProjectRecord[];
    readonly diagnostics: readonly OperationDiagnostic[];
    readonly evidenceLevel: "agent_runtime_verified" | "local_artifact";
}

interface OpenCodeRunningProjectDiscoveryDependencies {
    readonly inspectExecutable: (path: string) => ProviderRegularFileIdentity;
    readonly sameExecutable: (left: ProviderRegularFileIdentity, right: ProviderRegularFileIdentity) => boolean;
    readonly listProcessCandidates: (expectedExecutablePath: string, maximumEntries: number) => number[];
    readonly observeProcess: (
        processId: number,
        executablePath: string,
        executableIdentity: ProviderRegularFileIdentity,
        maximumCommandLineBytes: number,
    ) => ProviderLocalProcessObservation | null;
    readonly runExecutable: (
        executablePath: string,
        arguments_: readonly string[],
        options: {
            readonly expectedExecutableIdentity: ProviderRegularFileIdentity;
            readonly environment: NodeJS.ProcessEnv;
            readonly workingDirectory: string;
            readonly platformContext: PlatformContext;
            readonly hostPlatform: NodeJS.Platform;
            readonly timeoutMilliseconds: number;
            readonly maximumOutputBytes: number;
        },
    ) => Promise<OpenCodeBoundedInvocationResult>;
    readonly fetchProjects: (
        endpoint: string,
        options: {
            readonly authorizationHeader: string | undefined;
            readonly timeoutMilliseconds: number;
            readonly maximumOutputBytes: number;
        },
    ) => Promise<OpenCodeBoundedInvocationResult>;
    readonly now: () => number;
    readonly sleep: (milliseconds: number) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: OpenCodeRunningProjectDiscoveryDependencies = {
    inspectExecutable: inspectProviderRegularFileNoFollow,
    sameExecutable: sameProviderRegularFileIdentity,
    listProcessCandidates: listProviderLocalProcessExecutableCandidateIdsBounded,
    observeProcess: observeProviderLocalProcessExecutableBounded,
    runExecutable: invokeOpenCodeExecutableTreeBounded,
    fetchProjects: fetchOpenCodeProjectsBounded,
    now: Date.now,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

interface AttemptFailure {
    readonly retryable: boolean;
    readonly code: string;
    readonly message: string;
    readonly causeKind: "partial" | "invalid_schema" | "version_incompatible";
    readonly diagnosticPath?: string;
    readonly processVisibility?: "permission_limited";
}

interface AttemptSuccess {
    readonly projects: readonly OpenCodeProjectRecord[];
}

type AttemptResult = AttemptFailure | AttemptSuccess;

interface OpenCodeProjectDiscoveryDependencies {
    readonly discoverResolvedProfile: typeof discoverOpenCodeResolvedProfileProjects;
    readonly discoverRunning: (input: OpenCodeRunningProjectDiscoveryInput) => Promise<OpenCodeRunningProjectDiscoveryResult>;
    readonly discoverStopped: (
        input: Parameters<typeof discoverStoppedOpenCodeProjects>[0],
    ) => Promise<OpenCodeStoppedProjectDiscoveryResult>;
    readonly discoverCompatibilityDatabase: (
        input: Parameters<typeof discoverOpenCodeCompatibilityDatabase>[0],
    ) => Promise<OpenCodeCompatibilityDatabaseResult>;
}

const DEFAULT_PROJECT_DISCOVERY_DEPENDENCIES: OpenCodeProjectDiscoveryDependencies = {
    discoverResolvedProfile: discoverOpenCodeResolvedProfileProjects,
    discoverRunning: discoverRunningOpenCodeProjects,
    discoverStopped: discoverStoppedOpenCodeProjects,
    discoverCompatibilityDatabase: discoverOpenCodeCompatibilityDatabase,
};

export async function discoverOpenCodeProjects(
    input: OpenCodeProjectDiscoveryInput,
    overrides: Partial<OpenCodeProjectDiscoveryDependencies> = {},
): Promise<OpenCodeProjectDiscoveryResult> {
    const dependencies = { ...DEFAULT_PROJECT_DISCOVERY_DEPENDENCIES, ...overrides };
    if (input.executable !== null) {
        const running = await dependencies.discoverRunning({
            executablePath: input.executable.path,
            executableIdentity: input.executable.identity,
            environment: input.environment,
            workingDirectory: input.workingDirectory,
            platformContext: input.platformContext,
            hostPlatform: input.hostPlatform,
            diagnosticPath: input.diagnosticPath,
        });
        if (running.status !== "stopped") {
            if (
                running.processVisibility === "permission_limited" &&
                input.databasePath !== null &&
                input.platformContext.platform === "wsl" &&
                input.hostPlatform === "linux"
            ) {
                const profile = await dependencies.discoverResolvedProfile({
                    ...input,
                    executablePath: input.executable.path,
                    executableIdentity: input.executable.identity,
                    databasePath: input.databasePath,
                });
                return {
                    ...profile,
                    diagnostics: [
                        ...running.diagnostics.map((item) =>
                            profile.status === "complete"
                                ? {
                                      ...item,
                                      severity: "info" as const,
                                      message:
                                          "Process visibility is limited; the project query completed for the resolved OpenCode profile only",
                                      retryable: false,
                                      suggestedActions: [],
                                  }
                                : item,
                        ),
                        ...profile.diagnostics,
                    ],
                };
            }
            return {
                status: running.status,
                projects: running.projects,
                diagnostics: running.diagnostics,
                evidenceLevel: "agent_runtime_verified",
            };
        }
    }
    if (input.executable === null) {
        const result = partial(
            input,
            "opencode_stopped_exact_build_unavailable",
            "OpenCode is stopped and no exact installed executable is available for project discovery",
            "version_incompatible",
        );
        return { ...result, evidenceLevel: "local_artifact" };
    }
    if (input.databasePath === null) {
        const result = partial(
            input,
            "opencode_stopped_registry_unavailable",
            "OpenCode is stopped and the selected profile has no persistent project registry",
            "partial",
        );
        return { ...result, evidenceLevel: "local_artifact" };
    }
    const stopped = await dependencies.discoverStopped({
        executablePath: input.executable.path,
        executableIdentity: input.executable.identity,
        environment: input.environment,
        workingDirectory: input.workingDirectory,
        platformContext: input.platformContext,
        hostPlatform: input.hostPlatform,
        diagnosticPath: input.diagnosticPath,
        databasePath: input.databasePath,
    });
    if (stopped.status !== "complete" || stopped.projectDocument === null) {
        if (stopped.compatibilityFallback === "protocol_incompatible") {
            return compatibilityDatabaseFallback(input, input.databasePath, dependencies, stopped.diagnostics);
        }
        return {
            status: "partial",
            projects: [],
            diagnostics: stopped.diagnostics,
            evidenceLevel: "local_artifact",
        };
    }
    try {
        return {
            status: "complete",
            projects: parseOpenCodeProjectList(stopped.projectDocument, "stopped_debug_scrap"),
            diagnostics: [],
            evidenceLevel: "agent_runtime_verified",
        };
    } catch {
        const exactResult = partial(
            input,
            "opencode_stopped_exact_build_project_schema_invalid",
            "The exact stopped OpenCode build returned an incompatible project record",
            "invalid_schema",
        );
        return compatibilityDatabaseFallback(input, input.databasePath, dependencies, exactResult.diagnostics);
    }
}

async function compatibilityDatabaseFallback(
    input: OpenCodeProjectDiscoveryInput,
    databasePath: string,
    dependencies: OpenCodeProjectDiscoveryDependencies,
    exactDiagnostics: readonly OperationDiagnostic[],
): Promise<OpenCodeProjectDiscoveryResult> {
    const compatibility = await dependencies.discoverCompatibilityDatabase({
        databasePath,
        platformContext: input.platformContext,
    });
    if (compatibility.projectDocument === null) {
        return {
            status: "partial",
            projects: [],
            diagnostics: [...exactDiagnostics, ...compatibility.diagnostics],
            evidenceLevel: "local_artifact",
        };
    }
    try {
        return {
            status: "partial",
            projects: parseOpenCodeProjectList(compatibility.projectDocument, "compatibility_database"),
            diagnostics: [...exactDiagnostics, ...compatibility.diagnostics],
            evidenceLevel: "local_artifact",
        };
    } catch {
        const invalid = partial(
            input,
            "opencode_compatibility_database_project_schema_invalid",
            "The compatibility database returned an incompatible project record",
            "invalid_schema",
        );
        return {
            ...invalid,
            diagnostics: [...exactDiagnostics, ...compatibility.diagnostics, ...invalid.diagnostics],
            evidenceLevel: "local_artifact",
        };
    }
}

export async function discoverRunningOpenCodeProjects(
    input: OpenCodeRunningProjectDiscoveryInput,
    overrides: Partial<OpenCodeRunningProjectDiscoveryDependencies> = {},
): Promise<OpenCodeRunningProjectDiscoveryResult> {
    const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

    if (
        !["linux", "wsl", "win32"].includes(input.platformContext.platform) ||
        input.platformContext.accessRootPath.startsWith("\\\\")
    ) {
        return partial(
            input,
            "opencode_running_project_discovery_platform_unreviewed",
            "Running OpenCode project discovery is not reviewed for this selected platform target",
            "version_incompatible",
        );
    }

    const deadline = createProviderProbeDeadline(dependencies.now(), TOTAL_DEADLINE_MILLISECONDS);
    let lastFailure: AttemptFailure | null = null;
    for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
            const remainingBeforeDelay = remainingBudget(dependencies, deadline);
            if (remainingBeforeDelay === null || remainingBeforeDelay <= RETRY_DELAY_MILLISECONDS) break;
            await dependencies.sleep(RETRY_DELAY_MILLISECONDS);
        }
        if (remainingBudget(dependencies, deadline) === null) break;
        const result = await discoverOnce(input, dependencies, deadline);
        if ("projects" in result) {
            return { status: "complete", projects: result.projects, diagnostics: [] };
        }
        lastFailure = result;
        if (!result.retryable) break;
    }

    const failure =
        lastFailure ??
        ({
            retryable: true,
            code: "opencode_project_discovery_deadline_exceeded",
            message: "OpenCode project discovery did not stabilize within the bounded deadline",
            causeKind: "partial",
        } satisfies AttemptFailure);
    return failure.code === "opencode_running_build_not_found"
        ? { status: "stopped", projects: [], diagnostics: [] }
        : {
              ...partial(
                  { diagnosticPath: failure.diagnosticPath ?? input.diagnosticPath },
                  failure.code,
                  failure.message,
                  failure.causeKind,
              ),
              ...(failure.processVisibility === undefined ? {} : { processVisibility: failure.processVisibility }),
          };
}

async function discoverOnce(
    input: OpenCodeRunningProjectDiscoveryInput,
    dependencies: OpenCodeRunningProjectDiscoveryDependencies,
    deadline: ProviderProbeDeadline,
): Promise<AttemptResult> {
    if (remainingBudget(dependencies, deadline) === null) return deadlineExceeded();
    const executableCheck = await inspectExactExecutable(input, dependencies);
    if (executableCheck !== null) return executableCheck;
    if (remainingBudget(dependencies, deadline) === null) return deadlineExceeded();

    const processes = matchingProcesses(input, dependencies, deadline);
    if ("retryable" in processes) return processes;
    const debugProcess = processes[0];
    if (debugProcess === undefined) {
        return {
            retryable: false,
            code: "opencode_running_build_not_found",
            message: "The selected OpenCode build is not currently running, so OAAM did not start it for project discovery",
            causeKind: "partial",
        };
    }

    let timeoutMilliseconds = invocationTimeout(dependencies, deadline);
    if (timeoutMilliseconds === null) return deadlineExceeded();
    let debug: OpenCodeBoundedInvocationResult;
    try {
        debug = await dependencies.runExecutable(input.executablePath, ["debug", "scrap"], {
            expectedExecutableIdentity: input.executableIdentity,
            environment: input.environment,
            workingDirectory: input.workingDirectory,
            platformContext: input.platformContext,
            hostPlatform: input.hostPlatform,
            timeoutMilliseconds,
            maximumOutputBytes: MAXIMUM_PROJECT_OUTPUT_BYTES,
        });
    } catch (error) {
        return localInvocationOperationFailure(error);
    }
    let parsed = debug.status === "complete" ? parseInvocation(debug.stdout, "debug_scrap") : null;
    let failure = debug.status === "complete" ? parsed?.failure : invocationFailure("debug_scrap", debug);
    let processToRevalidate = debugProcess;

    if (parsed?.projects === undefined) {
        const endpoints = uniqueLoopbackEndpoints(processes);
        for (const candidate of endpoints) {
            timeoutMilliseconds = invocationTimeout(dependencies, deadline);
            if (timeoutMilliseconds === null) return deadlineExceeded();
            const http = await dependencies.fetchProjects(addDirectoryQuery(candidate.endpoint, input.workingDirectory), {
                authorizationHeader: authorizationHeader(input.environment),
                timeoutMilliseconds,
                maximumOutputBytes: MAXIMUM_PROJECT_OUTPUT_BYTES,
            });
            parsed = http.status === "complete" ? parseInvocation(http.stdout, "http_project_list") : null;
            failure = http.status === "complete" ? parsed?.failure : invocationFailure("http_project_list", http);
            if (parsed?.projects !== undefined) {
                processToRevalidate = candidate.process;
                break;
            }
            if (failure?.retryable) break;
        }
    }
    if (parsed?.projects === undefined) {
        return (
            failure ?? {
                retryable: false,
                code: "opencode_project_list_unavailable",
                message: "The exact running OpenCode build exposed no compatible bounded project-list result",
                causeKind: "partial",
            }
        );
    }

    if (invocationTimeout(dependencies, deadline) === null) return deadlineExceeded();
    const revalidation = await revalidateSelection(input, processToRevalidate, dependencies, deadline);
    return revalidation ?? { projects: parsed.projects };
}

function localInvocationOperationFailure(error: unknown): AttemptFailure {
    const failure = classifyProviderProcessObservationFailure(error);
    const retryable = failure.disposition === "retryable_transition";
    const suffix = failure.systemCode || failure.failureKind;
    return {
        retryable,
        code: retryable ? "opencode_local_invocation_transitioned" : `opencode_local_invocation_${suffix.toLowerCase()}`,
        message: retryable
            ? "The selected local runtime changed while its exact OpenCode build was invoked"
            : "The selected local runtime could not invoke the exact running OpenCode build",
        causeKind: failure.failureKind === "unsupported_platform" ? "version_incompatible" : "partial",
    };
}

function remainingBudget(
    dependencies: OpenCodeRunningProjectDiscoveryDependencies,
    deadline: ProviderProbeDeadline,
): number | null {
    return remainingProviderProbeDeadlineMilliseconds(deadline, dependencies.now());
}

function invocationTimeout(
    dependencies: OpenCodeRunningProjectDiscoveryDependencies,
    deadline: ProviderProbeDeadline,
): number | null {
    const remaining = remainingBudget(dependencies, deadline);
    return remaining === null ? null : Math.min(INVOCATION_TIMEOUT_MILLISECONDS, remaining);
}

function deadlineExceeded(): AttemptFailure {
    return {
        retryable: true,
        code: "opencode_project_discovery_deadline_exceeded",
        message: "OpenCode project discovery did not stabilize within the bounded deadline",
        causeKind: "partial",
    };
}

async function inspectExactExecutable(
    input: OpenCodeRunningProjectDiscoveryInput,
    dependencies: OpenCodeRunningProjectDiscoveryDependencies,
): Promise<AttemptFailure | null> {
    try {
        const current = dependencies.inspectExecutable(input.executablePath);
        if (dependencies.sameExecutable(current, input.executableIdentity)) return null;
        return {
            retryable: false,
            code: "opencode_executable_identity_changed",
            message: "The OpenCode executable changed after installation discovery and was not invoked",
            causeKind: "version_incompatible",
            diagnosticPath: input.executablePath,
        };
    } catch {
        return {
            retryable: false,
            code: "opencode_executable_revalidation_failed",
            message: "The OpenCode executable could not be revalidated and was not invoked",
            causeKind: "partial",
            diagnosticPath: input.executablePath,
        };
    }
}

function matchingProcesses(
    input: OpenCodeRunningProjectDiscoveryInput,
    dependencies: OpenCodeRunningProjectDiscoveryDependencies,
    deadline: ProviderProbeDeadline,
): ProviderLocalProcessObservation[] | AttemptFailure {
    if (remainingBudget(dependencies, deadline) === null) return deadlineExceeded();
    let processIds: number[];
    try {
        processIds = dependencies.listProcessCandidates(input.executablePath, MAXIMUM_PROCESS_IDS);
    } catch (error) {
        return processFailure("inventory", classifyProviderProcessObservationFailure(error));
    }
    if (remainingBudget(dependencies, deadline) === null) return deadlineExceeded();
    const matches: ProviderLocalProcessObservation[] = [];
    let transitionObserved = false;
    let deterministicFailure: AttemptFailure | null = null;
    for (const processId of processIds) {
        if (remainingBudget(dependencies, deadline) === null) return deadlineExceeded();
        try {
            const observation = dependencies.observeProcess(
                processId,
                input.executablePath,
                input.executableIdentity,
                MAXIMUM_COMMAND_LINE_BYTES,
            );
            if (observation !== null) matches.push(observation);
        } catch (error) {
            const failure = processFailure("observation", classifyProviderProcessObservationFailure(error));
            if (failure.retryable) {
                transitionObserved = true;
            } else {
                if (deterministicFailure === null || failure.processVisibility === undefined) deterministicFailure = failure;
            }
        }
        if (remainingBudget(dependencies, deadline) === null) return deadlineExceeded();
    }
    matches.sort((left, right) => left.processId - right.processId);
    if (matches.length === 0 && deterministicFailure !== null) return deterministicFailure;
    if (matches.length === 0 && transitionObserved) {
        return {
            retryable: true,
            code: "opencode_process_inventory_transitioned",
            message: "OpenCode process state changed while the bounded process inventory was observed",
            causeKind: "partial",
        };
    }
    return matches;
}

async function revalidateSelection(
    input: OpenCodeRunningProjectDiscoveryInput,
    selected: ProviderLocalProcessObservation,
    dependencies: OpenCodeRunningProjectDiscoveryDependencies,
    deadline: ProviderProbeDeadline,
): Promise<AttemptFailure | null> {
    if (remainingBudget(dependencies, deadline) === null) return deadlineExceeded();
    const executable = await inspectExactExecutable(input, dependencies);
    if (executable !== null) return executable;
    if (remainingBudget(dependencies, deadline) === null) return deadlineExceeded();
    try {
        const current = dependencies.observeProcess(
            selected.processId,
            input.executablePath,
            input.executableIdentity,
            MAXIMUM_COMMAND_LINE_BYTES,
        );
        if (remainingBudget(dependencies, deadline) === null) return deadlineExceeded();
        if (current !== null && current.lifecycleToken === selected.lifecycleToken) return null;
    } catch (error) {
        const failure = processFailure("revalidation", classifyProviderProcessObservationFailure(error));
        if (!failure.retryable) return failure;
    }
    return {
        retryable: true,
        code: "opencode_running_process_changed",
        message: "The selected OpenCode process changed while its public project list was read",
        causeKind: "partial",
    };
}

function processFailure(
    surface: "inventory" | "observation" | "revalidation",
    failure: ProviderProcessObservationFailure,
): AttemptFailure {
    const retryable = failure.disposition === "retryable_transition";
    const suffix = failure.systemCode || failure.failureKind;
    return {
        retryable,
        code: retryable ? `opencode_process_${surface}_transitioned` : `opencode_process_${surface}_${suffix.toLowerCase()}`,
        message: retryable
            ? "OpenCode process state changed while exact-build discovery observed the bounded process table"
            : "The selected platform could not provide the process evidence required for exact-build discovery",
        causeKind: failure.failureKind === "unsupported_platform" ? "version_incompatible" : "partial",
        ...(surface !== "revalidation" && failure.failureKind === "permission_denied"
            ? { processVisibility: "permission_limited" as const }
            : {}),
    };
}

function parseInvocation(
    bytes: Uint8Array,
    locatorSurface: "debug_scrap" | "http_project_list",
): { projects?: readonly OpenCodeProjectRecord[]; failure?: AttemptFailure } {
    try {
        return { projects: parseOpenCodeProjectList(bytes, locatorSurface) };
    } catch {
        return {
            failure: {
                retryable: false,
                code: "opencode_project_list_schema_invalid",
                message: "The exact OpenCode build returned an incompatible project-list document",
                causeKind: "invalid_schema",
            },
        };
    }
}

function invocationFailure(
    surface: "debug_scrap" | "http_project_list",
    result: OpenCodeBoundedInvocationResult,
): AttemptFailure {
    return {
        retryable: result.status === "transient",
        code: `opencode_${surface}_${result.failureCode || "failed"}`,
        message:
            surface === "debug_scrap"
                ? "The exact running OpenCode build did not return its bounded debug project list"
                : "The discovered loopback OpenCode endpoint did not return its bounded project list",
        causeKind: "partial",
    };
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueLoopbackEndpoints(
    processes: readonly ProviderLocalProcessObservation[],
): Array<{ endpoint: string; process: ProviderLocalProcessObservation }> {
    const endpoints = new Map<string, ProviderLocalProcessObservation>();
    for (const process of processes) {
        const arguments_ = decodeCommandLine(process.commandLineBytes);
        const serveArguments = explicitServeArguments(arguments_);
        if (serveArguments === null) continue;
        const port = optionValue(serveArguments, "--port");
        const hostname = optionValue(serveArguments, "--hostname");
        if (
            port === null ||
            hostname === null ||
            !/^[1-9][0-9]{0,4}$/u.test(port) ||
            Number(port) > 65_535 ||
            !["127.0.0.1", "localhost", "::1"].includes(hostname)
        ) {
            continue;
        }
        const address = hostname === "::1" ? `[${hostname}]` : hostname;
        const endpoint = `http://${address}:${port}/project`;
        if (!endpoints.has(endpoint)) endpoints.set(endpoint, process);
    }
    return [...endpoints.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([endpoint, process]) => ({ endpoint, process }));
}

function explicitServeArguments(arguments_: readonly string[]): readonly string[] | null {
    if (arguments_[1] !== "serve") return null;
    const separator = arguments_.indexOf("--", 2);
    return arguments_.slice(2, separator < 0 ? arguments_.length : separator);
}

function decodeCommandLine(bytes: Uint8Array): string[] {
    try {
        return new TextDecoder("utf-8", { fatal: true })
            .decode(bytes)
            .split("\0")
            .filter((item) => item.length > 0);
    } catch {
        return [];
    }
}

function optionValue(arguments_: readonly string[], option: string): string | null {
    const equals = arguments_.find((item) => item.startsWith(`${option}=`));
    if (equals !== undefined) return equals.slice(option.length + 1);
    const index = arguments_.indexOf(option);
    return index >= 0 ? (arguments_[index + 1] ?? null) : null;
}

function addDirectoryQuery(endpoint: string, directory: string): string {
    const url = new URL(endpoint);
    url.searchParams.set("directory", directory);
    return url.toString();
}

function authorizationHeader(environment: NodeJS.ProcessEnv): string | undefined {
    const password = environment.OPENCODE_SERVER_PASSWORD;
    if (!password) return undefined;
    const username = environment.OPENCODE_SERVER_USERNAME || "opencode";
    return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function partial(
    input: { readonly diagnosticPath: string },
    code: string,
    message: string,
    causeKind: "partial" | "invalid_schema" | "version_incompatible",
): OpenCodeRunningProjectDiscoveryResult & { readonly status: "partial" } {
    return {
        status: "partial",
        projects: [],
        diagnostics: [diagnostic(code, message, causeKind, "warning", input.diagnosticPath)],
    };
}
