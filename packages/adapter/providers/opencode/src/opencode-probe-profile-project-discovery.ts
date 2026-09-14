/** Fixed public read for the resolved WSL profile when process visibility is limited. */

import {
    canonicalProviderHostPathWithinAccessRoot,
    inspectProviderRegularFileNoFollow,
    invokeProviderLocalExecutableTreeBounded,
    probeDiagnostic,
} from "@oaam/adapter-framework";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import type { OpenCodeProjectDiscoveryResult } from "./opencode-probe-project-discovery";
import { parseOpenCodeProjectList } from "./opencode-probe-project-payload";
import {
    OPENCODE_PROJECT_DISCOVERY_ENVIRONMENT_VARIABLE_NAMES,
    type OpenCodeStoppedProjectDiscoveryInput,
} from "./opencode-probe-stopped-project-discovery";

// Independent public-read/concurrency proof: Phase 59 Addition 103, Lqqj2O.
// This is neither a target/load anchor nor evidence for logical Linux or other builds.
const VERIFIED_WSL_PROFILE_READ_BUILD = "sha256:8eb15fe87080dd11aa095cc0391eb3536d55a46fa9e4427c6a8b664d390ac089";

export async function discoverOpenCodeResolvedProfileProjects(
    input: OpenCodeStoppedProjectDiscoveryInput,
    overrides: Partial<{
        invoke: typeof invokeProviderLocalExecutableTreeBounded;
        inspectDatabase: typeof inspectProviderRegularFileNoFollow;
    }> = {},
): Promise<OpenCodeProjectDiscoveryResult> {
    const dependencies = {
        invoke: invokeProviderLocalExecutableTreeBounded,
        inspectDatabase: inspectProviderRegularFileNoFollow,
        ...overrides,
    };
    if (
        input.platformContext.platform !== "wsl" ||
        input.hostPlatform !== "linux" ||
        [input.executablePath, input.workingDirectory, input.databasePath].some(
            (path) => canonicalProviderHostPathWithinAccessRoot(path, input.platformContext) !== path,
        )
    ) {
        return failed(
            input,
            "binding_invalid",
            "The resolved OpenCode profile has no verified local WSL read binding",
            "version_incompatible",
        );
    }
    try {
        dependencies.inspectDatabase(input.databasePath);
        const invocation = await dependencies.invoke({
            executablePath: input.executablePath,
            expectedExecutableIdentity: input.executableIdentity,
            expectedExecutableSha256: VERIFIED_WSL_PROFILE_READ_BUILD,
            arguments: ["debug", "scrap"],
            workingDirectory: input.workingDirectory,
            environment: { ...input.environment, HOME: input.workingDirectory, OPENCODE_DB: input.databasePath },
            environmentVariableNames: OPENCODE_PROJECT_DISCOVERY_ENVIRONMENT_VARIABLE_NAMES,
            platformContext: input.platformContext,
            hostPlatform: input.hostPlatform,
            timeoutMilliseconds: 9_000,
            maximumOutputBytes: 4 * 1_024 * 1_024,
        });
        if (
            invocation.status !== "complete" ||
            invocation.exitCode !== 0 ||
            invocation.signal !== null ||
            !invocation.cleanupComplete ||
            !invocation.invocationTokenAbsent ||
            invocation.executableSha256 !== VERIFIED_WSL_PROFILE_READ_BUILD
        ) {
            return failed(
                input,
                "read_failed",
                "The exact OpenCode profile read did not complete with verified build identity and cleanup",
                "partial",
            );
        }
        try {
            return {
                status: "complete",
                projects: parseOpenCodeProjectList(invocation.stdout, "profile_debug_scrap"),
                diagnostics: [],
                evidenceLevel: "agent_runtime_verified",
            };
        } catch {
            return failed(
                input,
                "schema_invalid",
                "The exact OpenCode profile read returned an incompatible project-list document",
                "invalid_schema",
            );
        }
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        const unsupportedBuild = failure.systemCode === "EXECUTABLE_BUILD_MISMATCH";
        return failed(
            input,
            unsupportedBuild ? "build_unreviewed" : "read_unavailable",
            unsupportedBuild
                ? "The installed OpenCode build has no verified project read for limited process visibility"
                : "The resolved OpenCode profile could not be read through its exact installed build",
            unsupportedBuild
                ? "version_incompatible"
                : failure.failureKind === "permission_denied"
                  ? "permission_denied"
                  : "partial",
        );
    }
}

function failed(
    input: OpenCodeStoppedProjectDiscoveryInput,
    code: string,
    message: string,
    cause: "partial" | "invalid_schema" | "permission_denied" | "version_incompatible",
): OpenCodeProjectDiscoveryResult {
    return {
        status: "partial",
        projects: [],
        evidenceLevel: "local_artifact",
        diagnostics: [probeDiagnostic(`opencode_profile_${code}`, message, cause, "warning", input.diagnosticPath)],
    };
}
