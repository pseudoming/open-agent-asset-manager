/** Provider projection of the Framework-owned local executable-tree authority. */

import {
    invokeProviderLocalExecutableTreeBounded,
    type ProviderLocalExecutableTreeInvocationInput,
    type ProviderLocalExecutableTreeInvocationResult,
    type ProviderRegularFileIdentity,
} from "@oaam/adapter-framework";
import type { PlatformContext } from "@oaam/core";
import { OPENCODE_PROJECT_DISCOVERY_ENVIRONMENT_VARIABLE_NAMES } from "./opencode-probe-stopped-project-discovery";

export interface OpenCodeBoundedInvocationResult {
    readonly status: "complete" | "transient" | "failed";
    readonly stdout: Uint8Array;
    readonly failureCode: string;
}

export async function invokeOpenCodeExecutableTreeBounded(
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
    invoke: (
        input: ProviderLocalExecutableTreeInvocationInput,
    ) => Promise<ProviderLocalExecutableTreeInvocationResult> = invokeProviderLocalExecutableTreeBounded,
): Promise<OpenCodeBoundedInvocationResult> {
    const result = await invoke({
        executablePath,
        expectedExecutableIdentity: options.expectedExecutableIdentity,
        arguments: arguments_,
        workingDirectory: options.workingDirectory,
        environment: options.environment,
        environmentVariableNames: OPENCODE_PROJECT_DISCOVERY_ENVIRONMENT_VARIABLE_NAMES,
        platformContext: options.platformContext,
        hostPlatform: options.hostPlatform,
        timeoutMilliseconds: options.timeoutMilliseconds,
        maximumOutputBytes: options.maximumOutputBytes,
    });
    return {
        status: result.status === "complete" ? "complete" : result.status === "timed_out" ? "transient" : "failed",
        stdout: result.status === "complete" ? result.stdout : new Uint8Array(),
        failureCode: result.failureCode || (result.status === "complete" ? "" : result.status),
    };
}
