/** Target-local inherited-pipe process entry; no Provider or business-state construction. */
import { posix } from "node:path";
import { performance } from "node:perf_hooks";
import { inspectRegularFileNoFollow } from "@oaam/shared/filesystem";
import { observeLocalProcessExecutableBounded } from "@oaam/shared/paths";
import { runRestrictedTargetStdio } from "./restricted-target-stdio";
import { requireWindowsRestrictedCodeVerification, verifyRestrictedLoadedEntry } from "./restricted-code-admission";
import {
    requireRestrictedCodePackage,
    requireRestrictedCodeExecution,
    verifyRestrictedCodePackage,
    RestrictedCodePackageError,
    type RestrictedCodePackage,
} from "./restricted-code-package";

export type RestrictedServiceComposition = Pick<
    Parameters<typeof runRestrictedTargetStdio>[0],
    "service" | "session" | "deadlineAt" | "maximumFrameBytes" | "maximumConcurrentRequests"
>;

/** Bootstrap supplies the only operation constructor; launch inputs use one bounded private envelope. */
export function runRestrictedServiceProcess(
    compose: (configuration: unknown) => RestrictedServiceComposition | Promise<RestrictedServiceComposition>,
): Promise<void> {
    return runRestrictedServiceProcessForTest(compose, __filename);
}

/** @internal Controls supply the entry filename; production obtains it from its executing module. */
export async function runRestrictedServiceProcessForTest(
    compose: (configuration: unknown) => RestrictedServiceComposition | Promise<RestrictedServiceComposition>,
    loadedEntryPath: string,
): Promise<void> {
    const nodeEntryMilliseconds = performance.now();
    let ownedSession: { protocol: string; hostInstanceId: string; sessionId: string } | undefined;
    try {
        if (process.platform !== "linux") throw new Error("restricted service requires its Linux target build");
        const encoded = process.argv[2];
        if (encoded === undefined || encoded.length === 0 || encoded.length > 24_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
            throw new Error("invalid restricted process configuration encoding");
        }
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.toString("base64") !== encoded) throw new Error("non-canonical restricted process encoding");
        const configuration = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
            code: RestrictedCodePackage;
            session: { protocol: string; hostInstanceId: string; sessionId: string };
            operation: unknown;
            windowsCodeVerification?: unknown;
        };
        if (
            configuration === null ||
            typeof configuration !== "object" ||
            !["code,operation,session", "code,operation,session,windowsCodeVerification"].includes(
                Object.keys(configuration).sort().join(","),
            )
        ) {
            throw new Error("invalid restricted process configuration");
        }
        requireRestrictedCodePackage(configuration.code);
        const entryPath = posix.join(configuration.code.rootPath, "restricted-wsl.cjs");
        if (process.argv[1] !== entryPath || process.execPath !== posix.join(configuration.code.rootPath, "node"))
            throw new Error("restricted process is outside its exact code package");
        const observe = (pid: number, executable: string) => {
            const identity = inspectRegularFileNoFollow(executable);
            if (identity.entryKind !== "file") throw new Error("restricted process executable is not a regular file");
            const observed = observeLocalProcessExecutableBounded(pid, executable, { ...identity, entryKind: "file" }, 32_768);
            if (observed === null) throw new Error("restricted process identity is unavailable");
            return { processId: observed.processId, lifecycleToken: observed.lifecycleToken };
        };
        const identity = observe(process.pid, process.execPath);
        const parentIdentity = observe(process.ppid, "/usr/bin/timeout");
        const session = configuration.session;
        if (
            session === null ||
            typeof session !== "object" ||
            Object.keys(session).sort().join(",") !== "hostInstanceId,protocol,sessionId" ||
            typeof session.protocol !== "string" ||
            session.protocol.length > 128 ||
            !/^[a-f0-9-]{36}$/u.test(session.hostInstanceId) ||
            !/^[a-f0-9-]{36}$/u.test(session.sessionId)
        )
            throw new Error("invalid restricted process session");
        // Ownership precedes dependency validation, so a broken package can still be reaped by identity.
        process.stdout.write(
            JSON.stringify({ kind: "owned", ...session, processIdentity: { ...identity, parentIdentity } }) + "\n",
        );
        ownedSession = session;
        const runtimeValidationMilliseconds = performance.now() - nodeEntryMilliseconds;
        const verificationStarted = performance.now();
        requireRestrictedCodeExecution(configuration.code);
        if ("windowsCodeVerification" in configuration) {
            requireWindowsRestrictedCodeVerification(configuration.windowsCodeVerification, configuration.code, session);
            verifyRestrictedLoadedEntry(configuration.code, loadedEntryPath);
        } else {
            verifyRestrictedCodePackage(configuration.code);
        }
        const codeVerificationMilliseconds = performance.now() - verificationStarted;
        const compositionStarted = performance.now();
        const service = await compose(configuration.operation);
        const compositionMilliseconds = performance.now() - compositionStarted;
        if (
            service.session.protocol !== session.protocol ||
            service.session.hostInstanceId !== session.hostInstanceId ||
            service.session.sessionId !== session.sessionId
        )
            throw new Error("restricted composition session mismatch");
        const completed = await runRestrictedTargetStdio({
            ...service,
            processIdentity: { ...identity, parentIdentity },
            startupTiming: {
                nodeEntryMilliseconds,
                runtimeValidationMilliseconds,
                codeVerificationMilliseconds,
                compositionMilliseconds,
                processMaximumRssKiB: process.resourceUsage().maxRSS,
            },
            stdin: process.stdin,
            stdout: process.stdout,
        });
        if (completed.reason !== "shutdown" && completed.reason !== "eof" && completed.reason !== "idle") process.exitCode = 72;
    } catch (error) {
        if (ownedSession !== undefined)
            process.stdout.write(
                JSON.stringify({
                    kind: "startup-failure",
                    ...ownedSession,
                    failureCode: error instanceof RestrictedCodePackageError ? error.code : "startup_failed",
                    ...(error instanceof RestrictedCodePackageError ? { relativePath: error.relativePath } : {}),
                }) + "\n",
            );
        process.exitCode = 71;
    } finally {
        process.stdin.destroy();
    }
}
