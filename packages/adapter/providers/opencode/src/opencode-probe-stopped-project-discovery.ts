/** Exact-build project discovery for an OpenCode runtime that is not running. */

import {
    probeDiagnostic as diagnostic,
    invokeProviderLocalExecutableTreeBounded,
    type ProviderLocalExecutableTreeInvocationInput,
    type ProviderLocalExecutableTreeInvocationResult,
    type ProviderRegularFileIdentity,
} from "@oaam/adapter-framework";
import type { OperationDiagnostic, PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import { setTimeout as delay } from "node:timers/promises";

const MAXIMUM_ATTEMPTS = 3;
const RETRY_DELAY_MILLISECONDS = 3_000;
const TOTAL_DEADLINE_MILLISECONDS = 10_000;
const INVOCATION_TIMEOUT_MILLISECONDS = 9_000;
const MAXIMUM_PROJECT_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const MAXIMUM_COMMAND_HELP_BYTES = 64 * 1_024;

export const OPENCODE_PROJECT_DISCOVERY_ENVIRONMENT_VARIABLE_NAMES = [
    "APPDATA",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_DB",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENCODE_DISABLE_CLAUDE_CODE",
    "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
    "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS",
    "OPENCODE_DISABLE_EXTERNAL_SKILLS",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
] as const;

export interface OpenCodeStoppedProjectDiscoveryInput {
    readonly executablePath: string;
    readonly executableIdentity: ProviderRegularFileIdentity;
    readonly environment: NodeJS.ProcessEnv;
    readonly workingDirectory: string;
    readonly platformContext: PlatformContext;
    readonly hostPlatform: NodeJS.Platform;
    readonly diagnosticPath: string;
    readonly databasePath: string;
}

export interface OpenCodeStoppedProjectDiscoveryResult {
    readonly status: "complete" | "partial";
    readonly projectDocument: Uint8Array | null;
    readonly diagnostics: readonly OperationDiagnostic[];
    readonly compatibilityFallback: "not_allowed" | "protocol_incompatible";
}

interface AttemptSuccess {
    readonly projectDocument: Uint8Array;
}

interface AttemptFailure {
    readonly retryable: boolean;
    readonly code: string;
    readonly message: string;
    readonly causeKind: "partial" | "invalid_schema" | "permission_denied" | "version_incompatible";
    readonly compatibilityFallback?: "protocol_incompatible";
}

interface StoppedDiscoveryDependencies {
    readonly invoke: (input: ProviderLocalExecutableTreeInvocationInput) => Promise<ProviderLocalExecutableTreeInvocationResult>;
    readonly now: () => number;
    readonly sleep: (milliseconds: number) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: StoppedDiscoveryDependencies = {
    invoke: invokeProviderLocalExecutableTreeBounded,
    now: Date.now,
    sleep: delay,
};

export async function discoverStoppedOpenCodeProjects(
    input: OpenCodeStoppedProjectDiscoveryInput,
    overrides: Partial<StoppedDiscoveryDependencies> = {},
): Promise<OpenCodeStoppedProjectDiscoveryResult> {
    const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

    if (
        !["linux", "wsl", "win32"].includes(input.platformContext.platform) ||
        input.platformContext.accessRootPath.startsWith("\\\\")
    ) {
        return partial(
            input,
            "opencode_stopped_exact_build_platform_unreviewed",
            "Stopped OpenCode exact-build discovery is not reviewed for this selected platform target",
            "version_incompatible",
        );
    }

    const deadline = dependencies.now() + TOTAL_DEADLINE_MILLISECONDS;
    let lastFailure: AttemptFailure | null = null;
    for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
            const remainingBeforeDelay = deadline - dependencies.now();
            if (remainingBeforeDelay <= RETRY_DELAY_MILLISECONDS) break;
            await dependencies.sleep(RETRY_DELAY_MILLISECONDS);
        }
        const remaining = deadline - dependencies.now();
        if (remaining <= 0) break;
        const result = await discoverOnce(input, dependencies, Math.min(INVOCATION_TIMEOUT_MILLISECONDS, remaining));
        if ("projectDocument" in result) {
            return {
                status: "complete",
                projectDocument: result.projectDocument,
                diagnostics: [],
                compatibilityFallback: "not_allowed",
            };
        }
        lastFailure = result;
        if (!result.retryable) break;
    }
    const failure =
        lastFailure ??
        ({
            retryable: true,
            code: "opencode_stopped_exact_build_deadline_exceeded",
            message: "Stopped OpenCode exact-build discovery did not complete within the bounded deadline",
            causeKind: "partial",
        } satisfies AttemptFailure);
    const result = partial(input, failure.code, failure.message, failure.causeKind);
    return failure.compatibilityFallback === "protocol_incompatible"
        ? { ...result, compatibilityFallback: "protocol_incompatible" }
        : result;
}

async function discoverOnce(
    input: OpenCodeStoppedProjectDiscoveryInput,
    dependencies: StoppedDiscoveryDependencies,
    timeoutMilliseconds: number,
): Promise<AttemptSuccess | AttemptFailure> {
    try {
        const invocation = await dependencies.invoke({
            executablePath: input.executablePath,
            expectedExecutableIdentity: input.executableIdentity,
            arguments: ["debug", "scrap"],
            workingDirectory: input.workingDirectory,
            environment: input.environment,
            environmentVariableNames: OPENCODE_PROJECT_DISCOVERY_ENVIRONMENT_VARIABLE_NAMES,
            platformContext: input.platformContext,
            hostPlatform: input.hostPlatform,
            timeoutMilliseconds,
            maximumOutputBytes: MAXIMUM_PROJECT_OUTPUT_BYTES,
        });
        if (invocation.status !== "complete") return invocationFailure(invocation);
        if (invocation.exitCode !== 0 || !invocation.cleanupComplete || !invocation.invocationTokenAbsent) {
            return {
                retryable: false,
                code: "opencode_stopped_exact_build_result_invalid",
                message: "The exact OpenCode build did not return one naturally completed project list",
                causeKind: "partial",
            };
        }
        if (invocation.stdout.byteLength === 0) {
            return {
                retryable: false,
                code: "opencode_stopped_exact_build_result_invalid",
                message: "The exact OpenCode build returned an incompatible empty project-list protocol",
                causeKind: "invalid_schema",
                compatibilityFallback: "protocol_incompatible",
            };
        }
        return { projectDocument: invocation.stdout };
    } catch (error) {
        return invocationException(error);
    }
}

function invocationFailure(invocation: ProviderLocalExecutableTreeInvocationResult): AttemptFailure {
    const failureCode = invocation.failureCode || invocation.status;
    const cleanupFailure =
        invocation.status === "cleanup_failed" || !invocation.cleanupComplete || !invocation.invocationTokenAbsent;
    if (!cleanupFailure && isMissingDebugScrapCommand(invocation)) {
        return {
            retryable: false,
            code: "opencode_stopped_exact_build_command_unavailable",
            message: "The exact stopped OpenCode build does not provide the reviewed project-list command",
            causeKind: "version_incompatible",
            compatibilityFallback: "protocol_incompatible",
        };
    }
    return {
        retryable: !cleanupFailure && invocation.status === "timed_out",
        code: cleanupFailure
            ? "opencode_stopped_exact_build_process_tree_remains"
            : `opencode_stopped_exact_build_${failureCode}`,
        message: cleanupFailure
            ? "The OAAM-owned OpenCode invocation did not leave a provably empty process tree"
            : "The exact stopped OpenCode build did not return its bounded project list",
        causeKind: "partial",
    };
}

function isMissingDebugScrapCommand(invocation: ProviderLocalExecutableTreeInvocationResult): boolean {
    if (
        invocation.status !== "failed" ||
        invocation.failureCode !== "exit" ||
        invocation.exitCode === null ||
        invocation.exitCode === 0 ||
        invocation.stdout.byteLength !== 0 ||
        invocation.stderr.byteLength === 0 ||
        invocation.stderr.byteLength > MAXIMUM_COMMAND_HELP_BYTES ||
        !invocation.cleanupComplete ||
        !invocation.invocationTokenAbsent ||
        ("signal" in invocation && invocation.signal !== null)
    ) {
        return false;
    }
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(invocation.stderr).replaceAll("\r\n", "\n");
    } catch {
        return false;
    }
    if (
        !/^[\t\n\x20-\x7e]+$/.test(text) ||
        !text.startsWith("opencode debug\n\ndebugging and troubleshooting tools\n\nCommands:\n") ||
        !text.includes("\n\nOptions:\n")
    ) {
        return false;
    }
    const optionsMarkerIndex = text.indexOf("\n\nOptions:\n");
    const commandBlock = text.slice(text.indexOf("Commands:\n") + "Commands:\n".length, optionsMarkerIndex);
    const commandLines = commandBlock.split("\n").filter((line) => line.length > 0);
    const optionLines = text
        .slice(optionsMarkerIndex + "\n\nOptions:\n".length)
        .split("\n")
        .filter((line) => line.length > 0);
    return (
        commandLines.length > 0 &&
        commandLines.every((line) => line.startsWith("  opencode debug ")) &&
        !commandLines.some((line) => /^ {2}opencode debug scrap(?:\s|$)/.test(line)) &&
        optionLines.length > 0 &&
        optionLines.every((line) => line.startsWith("  ") && line.includes("--"))
    );
}

function invocationException(error: unknown): AttemptFailure {
    const failure = inspectFilesystemFailure(error);
    return {
        retryable: false,
        code: `opencode_stopped_exact_build_${failure.systemCode.toLowerCase()}`,
        message: "The selected OpenCode executable could not be invoked through the reviewed exact-build authority",
        causeKind: failure.failureKind === "permission_denied" ? "permission_denied" : "partial",
    };
}

function partial(
    input: OpenCodeStoppedProjectDiscoveryInput,
    code: string,
    message: string,
    causeKind: AttemptFailure["causeKind"],
): OpenCodeStoppedProjectDiscoveryResult {
    return {
        status: "partial",
        projectDocument: null,
        diagnostics: [diagnostic(code, message, causeKind, "warning", input.diagnosticPath || input.executablePath)],
        compatibilityFallback: "not_allowed",
    };
}
