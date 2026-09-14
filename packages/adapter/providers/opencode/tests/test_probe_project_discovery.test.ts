import { SafeFilesystemError } from "@oaam/shared/filesystem";
import { describe, expect, it } from "vitest";
import {
    discoverRunningOpenCodeProjects,
    fetchOpenCodeProjectsBounded,
    parseOpenCodeProjectList,
} from "../src/opencode-probe-project-discovery";
import type { OpenCodeBoundedInvocationResult } from "../src/opencode-probe-local-invocation";

const identity = { deviceId: "device", fileId: "file", entryKind: "file" } as const;
const otherIdentity = { deviceId: "device", fileId: "other", entryKind: "file" } as const;
const projectDocument = JSON.stringify([
    {
        id: "project-a",
        worktree: "/home/user/project-a",
        name: "Project A",
        sandboxes: ["/home/user/project-a-sandbox"],
        time: { created: 1, updated: 2 },
        commands: { start: "private ignored field" },
    },
]);

function observation(lifecycleToken = "100", arguments_: readonly string[] = ["/home/user/.opencode/bin/opencode"]) {
    return {
        processId: 42,
        lifecycleToken,
        executableIdentity: identity,
        commandLineBytes: Buffer.from(`${arguments_.join("\0")}\0`, "utf8"),
    };
}

function input(platform: "darwin" | "linux" | "wsl" | "win32" = "linux") {
    const win32 = platform === "win32";
    const executablePath = win32
        ? "C:\\Users\\user\\AppData\\Local\\OpenCode\\opencode.exe"
        : "/home/user/.opencode/bin/opencode";
    const workingDirectory = win32 ? "C:\\Users\\user" : "/home/user";
    return {
        executablePath,
        executableIdentity: identity,
        environment: win32 ? { USERPROFILE: workingDirectory } : { HOME: workingDirectory },
        workingDirectory,
        platformContext: {
            platform,
            platformInstanceId: platform,
            accessRootPath: workingDirectory,
        },
        hostPlatform: win32 ? ("win32" as const) : platform === "darwin" ? ("darwin" as const) : ("linux" as const),
        diagnosticPath: win32
            ? "C:\\Users\\user\\AppData\\Local\\OpenCode\\opencode.db"
            : "/home/user/.local/share/opencode/opencode.db",
    } as const;
}

function complete(stdout = projectDocument): OpenCodeBoundedInvocationResult {
    return { status: "complete", stdout: Buffer.from(stdout, "utf8"), failureCode: "" };
}

function failed(status: "failed" | "transient" = "failed"): OpenCodeBoundedInvocationResult {
    return { status, stdout: new Uint8Array(), failureCode: status };
}

function systemError(code: string): Error {
    return Object.assign(new Error(code), { code });
}

describe("OpenCode exact-running-build project discovery", () => {
    it("invokes only the matched executable and revalidates its lifecycle", async () => {
        const calls: Array<{
            path: string;
            arguments_: readonly string[];
            identity: string;
            platform: string;
            timeout: number;
            maximum: number;
        }> = [];
        const inventoryCalls: Array<{ executablePath: string; maximumEntries: number }> = [];
        const result = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: (left, right) => left.fileId === right.fileId,
            listProcessCandidates: (executablePath, maximumEntries) => {
                inventoryCalls.push({ executablePath, maximumEntries });
                return [42];
            },
            observeProcess: () => observation(),
            runExecutable: async (path, arguments_, options) => {
                calls.push({
                    path,
                    arguments_,
                    identity: options.expectedExecutableIdentity.fileId,
                    platform: options.platformContext.platform,
                    timeout: options.timeoutMilliseconds,
                    maximum: options.maximumOutputBytes,
                });
                return complete();
            },
            fetchProjects: async () => {
                throw new Error("HTTP fallback must not run after debug scrap succeeds");
            },
            now: () => 0,
            sleep: async () => undefined,
        });

        expect(result).toMatchObject({
            status: "complete",
            diagnostics: [],
            projects: [
                {
                    runtimeProjectKey: "project-a",
                    primaryRuntimePath: "/home/user/project-a",
                    additionalRuntimePaths: ["/home/user/project-a-sandbox"],
                },
            ],
        });
        expect(calls).toEqual([
            {
                path: input().executablePath,
                arguments_: ["debug", "scrap"],
                identity: "file",
                platform: "linux",
                timeout: 1_500,
                maximum: 4 * 1_024 * 1_024,
            },
        ]);
        expect(inventoryCalls).toEqual([{ executablePath: input().executablePath, maximumEntries: 65_536 }]);
    });

    it("does not invoke a changed build or a stopped runtime", async () => {
        let calls = 0;
        const changed = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => otherIdentity,
            sameExecutable: (left, right) => left.fileId === right.fileId,
            listProcessCandidates: () => [42],
            observeProcess: () => observation(),
            runExecutable: async () => {
                calls += 1;
                return complete();
            },
        });
        expect(changed.diagnostics[0]?.code).toBe("opencode_executable_identity_changed");

        const stopped = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: (left, right) => left.fileId === right.fileId,
            listProcessCandidates: () => [],
            observeProcess: () => {
                throw new Error("an empty executable candidate inventory must not be observed");
            },
            runExecutable: async () => {
                calls += 1;
                return complete();
            },
        });
        expect(stopped).toEqual({ status: "stopped", projects: [], diagnostics: [] });
        expect(calls).toBe(0);
    });

    it("does not publish captured project JSON when the owned executable tree fails cleanup", async () => {
        const result = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => [42],
            observeProcess: () => observation(),
            runExecutable: async () => ({
                status: "failed",
                stdout: Buffer.from(projectDocument, "utf8"),
                failureCode: "residual_process",
            }),
            now: () => 0,
        });

        expect(result).toMatchObject({
            status: "partial",
            projects: [],
            diagnostics: [{ code: "opencode_debug_scrap_residual_process" }],
        });
    });

    it("uses the exact path-aware process observation on a native Windows selection", async () => {
        const selected = input("win32");
        const observations: Array<{
            processId: number;
            executablePath: string;
            executableIdentity: typeof identity;
            maximumCommandLineBytes: number;
        }> = [];
        const result = await discoverRunningOpenCodeProjects(selected, {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => [42],
            observeProcess: (processId, executablePath, executableIdentity, maximumCommandLineBytes) => {
                observations.push({ processId, executablePath, executableIdentity, maximumCommandLineBytes });
                return observation("100", [selected.executablePath]);
            },
            runExecutable: async () => complete(),
            now: () => 0,
        });

        expect(result.status).toBe("complete");
        expect(observations).toEqual([
            {
                processId: 42,
                executablePath: selected.executablePath,
                executableIdentity: identity,
                maximumCommandLineBytes: 65_536,
            },
            {
                processId: 42,
                executablePath: selected.executablePath,
                executableIdentity: identity,
                maximumCommandLineBytes: 65_536,
            },
        ]);
    });

    it("uses only an explicit loopback endpoint when debug scrap is unavailable", async () => {
        let endpoint = "";
        let authorizationHeader: string | undefined;
        const running = observation("100", [input().executablePath, "serve", "--port", "4096", "--hostname=127.0.0.1"]);
        const result = await discoverRunningOpenCodeProjects(
            {
                ...input(),
                environment: {
                    HOME: "/home/user",
                    OPENCODE_SERVER_USERNAME: "reader",
                    OPENCODE_SERVER_PASSWORD: "secret",
                },
            },
            {
                inspectExecutable: () => identity,
                sameExecutable: (left, right) => left.fileId === right.fileId,
                listProcessCandidates: () => [42],
                observeProcess: () => running,
                runExecutable: async () => failed(),
                fetchProjects: async (value, options) => {
                    endpoint = value;
                    authorizationHeader = options.authorizationHeader;
                    return complete();
                },
                now: () => 0,
                sleep: async () => undefined,
            },
        );
        expect(result.status).toBe("complete");
        expect(endpoint).toBe("http://127.0.0.1:4096/project?directory=%2Fhome%2Fuser");
        expect(authorizationHeader).toBe(`Basic ${Buffer.from("reader:secret", "utf8").toString("base64")}`);
        expect(result.projects[0]?.locatorKey).toBe("http_project_list:project-a");
    });

    it("tries deterministic loopback endpoints in order and uses the default authenticated username", async () => {
        const processes = new Map([
            [42, observation("first", [input().executablePath, "serve", "--port=4096", "--hostname=127.0.0.1"])],
            [
                43,
                {
                    ...observation("second", [input().executablePath, "serve", "--port", "4097", "--hostname", "localhost"]),
                    processId: 43,
                },
            ],
        ]);
        const endpoints: string[] = [];
        const authorizations: Array<string | undefined> = [];
        const result = await discoverRunningOpenCodeProjects(
            {
                ...input(),
                environment: { HOME: "/home/user", OPENCODE_SERVER_PASSWORD: "secret" },
            },
            {
                inspectExecutable: () => identity,
                sameExecutable: () => true,
                listProcessCandidates: () => [...processes.keys()],
                observeProcess: (processId) => processes.get(processId) ?? null,
                runExecutable: async () => failed(),
                fetchProjects: async (endpoint, options) => {
                    endpoints.push(endpoint);
                    authorizations.push(options.authorizationHeader);
                    return endpoints.length === 1 ? failed() : complete();
                },
                now: () => 0,
            },
        );
        expect(result.status).toBe("complete");
        expect(endpoints).toEqual([
            "http://127.0.0.1:4096/project?directory=%2Fhome%2Fuser",
            "http://localhost:4097/project?directory=%2Fhome%2Fuser",
        ]);
        expect(authorizations).toEqual([
            `Basic ${Buffer.from("opencode:secret", "utf8").toString("base64")}`,
            `Basic ${Buffer.from("opencode:secret", "utf8").toString("base64")}`,
        ]);
    });

    it("does not contact another endpoint after the total discovery deadline is exhausted", async () => {
        const processes = new Map([
            [42, observation("first", [input().executablePath, "serve", "--port=4096", "--hostname=127.0.0.1"])],
            [
                43,
                {
                    ...observation("second", [input().executablePath, "serve", "--port=4097", "--hostname=localhost"]),
                    processId: 43,
                },
            ],
        ]);
        let now = 0;
        const endpoints: string[] = [];
        const result = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => [...processes.keys()],
            observeProcess: (processId) => processes.get(processId) ?? null,
            runExecutable: async () => failed(),
            fetchProjects: async (endpoint) => {
                endpoints.push(endpoint);
                now = 10_001;
                return failed();
            },
            now: () => now,
        });
        expect(endpoints).toEqual(["http://127.0.0.1:4096/project?directory=%2Fhome%2Fuser"]);
        expect(result.diagnostics[0]?.code).toBe("opencode_project_discovery_deadline_exceeded");
    });

    it("revalidates the process that supplied the successful loopback endpoint", async () => {
        const tui = observation("tui");
        const server = {
            ...observation("server", [input().executablePath, "serve", "--port=4096", "--hostname=127.0.0.1"]),
            processId: 43,
        };
        const observations = new Map([
            [42, tui],
            [43, server],
        ]);
        let serverReads = 0;
        const run = (serverSurvives: boolean) => {
            let now = 0;
            return discoverRunningOpenCodeProjects(input(), {
                inspectExecutable: () => identity,
                sameExecutable: () => true,
                listProcessCandidates: () => [42, 43],
                observeProcess: (processId) => {
                    if (processId === 43) {
                        serverReads += 1;
                        if (!serverSurvives && serverReads > 1) return null;
                    }
                    return observations.get(processId) ?? null;
                },
                runExecutable: async () => failed(),
                fetchProjects: async () => complete(),
                now: () => now,
                sleep: async () => {
                    now = 10_000;
                },
            });
        };

        expect((await run(true)).status).toBe("complete");
        serverReads = 0;
        expect((await run(false)).diagnostics[0]?.code).toBe("opencode_running_process_changed");
    });

    it("does not guess an endpoint and treats malformed output as deterministic", async () => {
        let fetches = 0;
        let executions = 0;
        const result = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: (left, right) => left.fileId === right.fileId,
            listProcessCandidates: () => [42],
            observeProcess: () => observation(),
            runExecutable: async () => {
                executions += 1;
                return complete("{not-json");
            },
            fetchProjects: async () => {
                fetches += 1;
                return complete();
            },
            now: () => 0,
            sleep: async () => undefined,
        });
        expect(result.diagnostics[0]?.code).toBe("opencode_project_list_schema_invalid");
        expect(executions).toBe(1);
        expect(fetches).toBe(0);
    });

    it("retries transient failures at most three times within the ten-second budget", async () => {
        let now = 0;
        let executions = 0;
        const delays: number[] = [];
        const result = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: (left, right) => left.fileId === right.fileId,
            listProcessCandidates: () => [42],
            observeProcess: () => observation(),
            runExecutable: async () => {
                executions += 1;
                return executions < 3 ? failed("transient") : complete();
            },
            fetchProjects: async () => failed("transient"),
            now: () => now,
            sleep: async (milliseconds) => {
                delays.push(milliseconds);
                now += milliseconds;
            },
        });
        expect(result.status).toBe("complete");
        expect(executions).toBe(3);
        expect(delays).toEqual([3_000, 3_000]);
        expect(now).toBeLessThan(10_000);
    });

    it("rejects output when the selected PID lifecycle changes", async () => {
        let observations = 0;
        let executions = 0;
        let now = 0;
        const result = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: (left, right) => left.fileId === right.fileId,
            listProcessCandidates: () => [42],
            observeProcess: () => {
                observations += 1;
                return observation(observations % 2 === 1 ? "before" : "after");
            },
            runExecutable: async () => {
                executions += 1;
                return complete();
            },
            fetchProjects: async () => failed(),
            now: () => now,
            sleep: async (milliseconds) => {
                now += milliseconds;
            },
        });
        expect(result.diagnostics[0]?.code).toBe("opencode_running_process_changed");
        expect(executions).toBe(3);
    });

    it("retries an allowlisted process-table transition but not a deterministic observation failure", async () => {
        let observations = 0;
        let now = 0;
        const transitioned = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: (left, right) => left.fileId === right.fileId,
            listProcessCandidates: () => [42],
            observeProcess: () => {
                observations += 1;
                if (observations === 1) throw systemError("ENOENT");
                return observation();
            },
            runExecutable: async () => complete(),
            fetchProjects: async () => failed(),
            now: () => now,
            sleep: async (milliseconds) => {
                now += milliseconds;
            },
        });
        expect(transitioned.status).toBe("complete");

        let deterministicObservations = 0;
        let deterministicSleeps = 0;
        const deterministic = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => [42],
            observeProcess: () => {
                deterministicObservations += 1;
                throw systemError("EACCES");
            },
            sleep: async () => {
                deterministicSleeps += 1;
            },
        });
        expect(deterministic.diagnostics[0]?.code).toBe("opencode_process_observation_eacces");
        expect(deterministicObservations).toBe(1);
        expect(deterministicSleeps).toBe(0);

        const unsupported = await discoverRunningOpenCodeProjects(input("darwin"));
        expect(unsupported.diagnostics[0]?.code).toBe("opencode_running_project_discovery_platform_unreviewed");
        const selectedWslFromWindows = await discoverRunningOpenCodeProjects({
            ...input("wsl"),
            platformContext: {
                platform: "wsl",
                platformInstanceId: "wsl:Ubuntu",
                accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\user",
            },
        });
        expect(selectedWslFromWindows.diagnostics[0]?.code).toBe("opencode_running_project_discovery_platform_unreviewed");
    });

    it("retries only transient local invocation authority failures and preserves deterministic causes", async () => {
        let invocations = 0;
        let now = 0;
        const transitioned = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => [42],
            observeProcess: () => observation(),
            runExecutable: async () => {
                invocations += 1;
                if (invocations === 1) throw systemError("ENOENT");
                return complete();
            },
            now: () => now,
            sleep: async (milliseconds) => {
                now += milliseconds;
            },
        });
        expect(transitioned.status).toBe("complete");
        expect(invocations).toBe(2);

        for (const [code, expectedCode, causeKind] of [
            ["EACCES", "opencode_local_invocation_eacces", "partial"],
            ["ENOSYS", "opencode_local_invocation_enosys", "version_incompatible"],
        ] as const) {
            let calls = 0;
            const result = await discoverRunningOpenCodeProjects(input(), {
                inspectExecutable: () => identity,
                sameExecutable: () => true,
                listProcessCandidates: () => [42],
                observeProcess: () => observation(),
                runExecutable: async () => {
                    calls += 1;
                    throw systemError(code);
                },
                now: () => 0,
            });
            expect(result).toMatchObject({
                status: "partial",
                projects: [],
                diagnostics: [{ code: expectedCode, causeKind }],
            });
            expect(calls).toBe(1);
        }
    });

    it("retries a busy inventory but fails closed on unsupported observation and deterministic revalidation", async () => {
        let now = 0;
        let inventories = 0;
        const busy = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => {
                inventories += 1;
                if (inventories === 1) throw systemError("EBUSY");
                return [42];
            },
            observeProcess: () => observation(),
            runExecutable: async () => complete(),
            now: () => now,
            sleep: async (milliseconds) => {
                now += milliseconds;
            },
        });
        expect(busy.status).toBe("complete");
        expect(inventories).toBe(2);

        const mixedInventory = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => [1, 42],
            observeProcess: (processId) => {
                if (processId === 1) throw systemError("EACCES");
                return observation();
            },
            runExecutable: async () => complete(),
            now: () => 0,
        });
        expect(mixedInventory.status).toBe("complete");

        const unsupported = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => [42],
            observeProcess: () => {
                throw new SafeFilesystemError({
                    failureKind: "unsupported_platform",
                    operation: "observe_local_process",
                    targetPath: "/proc/42",
                    message: "unsupported fixture",
                });
            },
        });
        expect(unsupported.diagnostics[0]).toMatchObject({
            code: "opencode_process_observation_unknown",
            causeKind: "version_incompatible",
        });

        let observations = 0;
        let sleeps = 0;
        const revalidation = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => [42],
            observeProcess: () => {
                observations += 1;
                if (observations > 1) throw systemError("EACCES");
                return observation();
            },
            runExecutable: async () => complete(),
            sleep: async () => {
                sleeps += 1;
            },
            now: () => 0,
        });
        expect(revalidation.diagnostics[0]?.code).toBe("opencode_process_revalidation_eacces");
        expect(revalidation.processVisibility).toBeUndefined();
        expect(sleeps).toBe(0);
    });

    it("fails closed when executable or process inventory revalidation is unavailable", async () => {
        const executable = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => {
                throw new Error("unreadable executable");
            },
        });
        expect(executable.diagnostics[0]?.code).toBe("opencode_executable_revalidation_failed");

        const inventory = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => {
                throw new Error("unsupported inventory");
            },
        });
        expect(inventory.diagnostics[0]?.code).toBe("opencode_process_inventory_unknown");
    });

    it("checks the total deadline around inventory and every process observation", async () => {
        let inventoryNow = 0;
        let inventoryObservations = 0;
        const inventory = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => {
                inventoryNow = 10_001;
                return [42];
            },
            observeProcess: () => {
                inventoryObservations += 1;
                return observation();
            },
            now: () => inventoryNow,
        });
        expect(inventory.diagnostics[0]?.code).toBe("opencode_project_discovery_deadline_exceeded");
        expect(inventoryObservations).toBe(0);

        let observationNow = 0;
        let executions = 0;
        const observed = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => [42, 43],
            observeProcess: () => {
                observationNow = 10_001;
                return observation();
            },
            runExecutable: async () => {
                executions += 1;
                return complete();
            },
            now: () => observationNow,
        });
        expect(observed.diagnostics[0]?.code).toBe("opencode_project_discovery_deadline_exceeded");
        expect(executions).toBe(0);
    });

    it("stops retries when the remaining deadline cannot hold another three-second delay", async () => {
        let now = 0;
        let executions = 0;
        const result = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => [42],
            observeProcess: () => observation(),
            runExecutable: async () => {
                executions += 1;
                now = 8_000;
                return failed("transient");
            },
            fetchProjects: async () => failed("transient"),
            now: () => now,
        });
        expect(result.diagnostics[0]?.code).toContain("transient");
        expect(executions).toBe(1);

        let calls = 0;
        const expired = await discoverRunningOpenCodeProjects(input(), {
            now: () => {
                calls += 1;
                return calls === 1 ? 0 : 10_001;
            },
        });
        expect(expired.diagnostics[0]?.code).toBe("opencode_project_discovery_deadline_exceeded");
    });

    it("accepts only an explicit valid loopback endpoint and reports a process-table transition", async () => {
        const processes = new Map([
            [1, observation("one", [input().executablePath, "serve", "--port=70000", "--hostname=127.0.0.1"])],
            [2, { ...observation("two"), processId: 2, commandLineBytes: new Uint8Array([0xff]) }],
            [3, observation("three", [input().executablePath, "serve", "--port=4096", "--hostname=0.0.0.0"])],
            [4, observation("four", [input().executablePath, "serve", "--port=4096", "--hostname=::1"])],
        ]);
        let endpoint = "";
        let observations = 0;
        const result = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            sameExecutable: () => true,
            listProcessCandidates: () => [...processes.keys()],
            observeProcess: (processId) => {
                observations += 1;
                if (observations > processes.size) throw systemError("ENOENT");
                return processes.get(processId) ?? null;
            },
            runExecutable: async () => failed(),
            fetchProjects: async (value, options) => {
                endpoint = value;
                expect(options.authorizationHeader).toBeUndefined();
                return complete();
            },
            now: () => 0,
            sleep: async () => undefined,
        });
        expect(endpoint).toBe("http://[::1]:4096/project?directory=%2Fhome%2Fuser");
        expect(result.diagnostics[0]?.code).toBe("opencode_process_inventory_transitioned");
    });

    it("never sends credentials to port-like arguments outside an explicit serve command", async () => {
        const processes = new Map([
            [1, observation("run", [input().executablePath, "run", "--port=4096", "--hostname=127.0.0.1"])],
            [2, observation("payload", [input().executablePath, "serve", "--", "--port=4097", "--hostname=localhost"])],
            [3, observation("missing", [input().executablePath, "serve", "--hostname=localhost", "--port"])],
        ]);
        let fetches = 0;
        const result = await discoverRunningOpenCodeProjects(
            {
                ...input(),
                environment: { HOME: "/home/user", OPENCODE_SERVER_PASSWORD: "must-not-leak" },
            },
            {
                inspectExecutable: () => identity,
                sameExecutable: () => true,
                listProcessCandidates: () => [...processes.keys()],
                observeProcess: (processId) => processes.get(processId) ?? null,
                runExecutable: async () => ({ status: "failed", stdout: new Uint8Array(), failureCode: "" }),
                fetchProjects: async () => {
                    fetches += 1;
                    return complete();
                },
                now: () => 0,
            },
        );
        expect(result.diagnostics[0]?.code).toBe("opencode_debug_scrap_failed");
        expect(fetches).toBe(0);
    });
});

describe("OpenCode project-list schema", () => {
    it("projects only bounded project identity and sorts independently of input order", () => {
        const value = [
            {
                id: "z",
                worktree: "/z",
                sandboxes: ["/z/b", "/z/a", "/z/a", "/z"],
                session: [{ body: "must not be projected" }],
            },
            { id: "a", worktree: "/a", name: "Alpha", sandboxes: [] },
        ];
        const records = parseOpenCodeProjectList(Buffer.from(JSON.stringify(value), "utf8"));
        expect(records).toEqual([
            {
                runtimeProjectKey: "a",
                displayName: "Alpha",
                primaryRuntimePath: "/a",
                additionalRuntimePaths: [],
                locatorKey: "debug_scrap:a",
            },
            {
                runtimeProjectKey: "z",
                displayName: "",
                primaryRuntimePath: "/z",
                additionalRuntimePaths: ["/z/a", "/z/b"],
                locatorKey: "debug_scrap:z",
            },
        ]);
        expect(JSON.stringify(records)).not.toContain("session");
    });

    it("omits the OpenCode internal global identity after validating every row", () => {
        const records = parseOpenCodeProjectList(
            Buffer.from(
                JSON.stringify([
                    { id: "global", worktree: "/", sandboxes: [], time: { updated: 123 } },
                    { id: "global-history", worktree: "/historical-context", vcs: "git", sandboxes: [] },
                    { id: "project", worktree: "/project", sandboxes: [] },
                ]),
            ),
        );
        expect(records).toEqual([
            {
                runtimeProjectKey: "global-history",
                displayName: "",
                primaryRuntimePath: "/historical-context",
                additionalRuntimePaths: [],
                locatorKey: "debug_scrap:global-history",
            },
            {
                runtimeProjectKey: "project",
                displayName: "",
                primaryRuntimePath: "/project",
                additionalRuntimePaths: [],
                locatorKey: "debug_scrap:project",
            },
        ]);
        expect(
            parseOpenCodeProjectList(
                Buffer.from(
                    JSON.stringify([
                        { id: "global", worktree: "/historical-context", vcs: "git", sandboxes: ["/historical-sandbox"] },
                    ]),
                ),
            ),
        ).toEqual([]);
        expect(() =>
            parseOpenCodeProjectList(Buffer.from(JSON.stringify([{ id: "global", worktree: 1, sandboxes: [] }]))),
        ).toThrow(TypeError);
        expect(() =>
            parseOpenCodeProjectList(Buffer.from(JSON.stringify([{ id: "global", worktree: "/", sandboxes: [1] }]))),
        ).toThrow(TypeError);
    });

    it.each([
        ["not an array", {}],
        [
            "duplicate identity",
            [
                { id: "a", worktree: "/a", sandboxes: [] },
                { id: "a", worktree: "/b", sandboxes: [] },
            ],
        ],
        ["untrimmed identity", [{ id: " a", worktree: "/a", sandboxes: [] }]],
        ["missing sandboxes", [{ id: "a", worktree: "/a" }]],
        ["invalid sandbox", [{ id: "a", worktree: "/a", sandboxes: [1] }]],
    ])("rejects %s", (_label, value) => {
        expect(() => parseOpenCodeProjectList(Buffer.from(JSON.stringify(value), "utf8"))).toThrow(TypeError);
    });

    it("rejects invalid UTF-8", () => {
        expect(() => parseOpenCodeProjectList(new Uint8Array([0xff]))).toThrow();
    });

    it("accepts a null display name but rejects resource limits and non-record entries", () => {
        expect(
            parseOpenCodeProjectList(Buffer.from(JSON.stringify([{ id: "a", worktree: "/a", name: null, sandboxes: [] }]))),
        ).toEqual([
            {
                runtimeProjectKey: "a",
                displayName: "",
                primaryRuntimePath: "/a",
                additionalRuntimePaths: [],
                locatorKey: "debug_scrap:a",
            },
        ]);
        expect(() => parseOpenCodeProjectList(Buffer.from(JSON.stringify(Array.from({ length: 10_001 }, () => ({})))))).toThrow(
            TypeError,
        );
        expect(() =>
            parseOpenCodeProjectList(Buffer.from(JSON.stringify([{ id: "a".repeat(32_769), worktree: "/a", sandboxes: [] }]))),
        ).toThrow(TypeError);
        expect(() => parseOpenCodeProjectList(Buffer.from("[null]"))).toThrow(TypeError);
    });
});

describe("OpenCode bounded public-list transports", () => {
    it("bounds loopback HTTP status, authentication and body size", async () => {
        let authorization = "";
        const options = {
            authorizationHeader: "Basic fixture",
            timeoutMilliseconds: 1_000,
            maximumOutputBytes: 1_024,
        };
        const success = await fetchOpenCodeProjectsBounded("http://127.0.0.1:4096/project", options, async (_url, init) => {
            authorization = new Headers(init?.headers).get("authorization") ?? "";
            return new Response("[]", { status: 200 });
        });
        expect(Buffer.from(success.stdout).toString("utf8")).toBe("[]");
        expect(authorization).toBe("Basic fixture");

        const retry = await fetchOpenCodeProjectsBounded(
            "http://127.0.0.1:4096/project",
            options,
            async () => new Response("", { status: 503 }),
        );
        expect(retry.status).toBe("transient");
        const rateLimited = await fetchOpenCodeProjectsBounded(
            "http://127.0.0.1:4096/project",
            options,
            async () => new Response("", { status: 429 }),
        );
        expect(rateLimited.status).toBe("transient");
        const notFound = await fetchOpenCodeProjectsBounded(
            "http://127.0.0.1:4096/project",
            options,
            async () => new Response("", { status: 404 }),
        );
        expect(notFound.status).toBe("failed");
        const empty = await fetchOpenCodeProjectsBounded(
            "http://127.0.0.1:4096/project",
            options,
            async () => new Response(null, { status: 200 }),
        );
        expect(empty.failureCode).toBe("empty_body");

        const large = await fetchOpenCodeProjectsBounded(
            "http://127.0.0.1:4096/project",
            { ...options, maximumOutputBytes: 64 },
            async () => new Response("x".repeat(2_048), { status: 200 }),
        );
        expect(large).toMatchObject({ status: "failed", failureCode: "output_limit" });
        const network = await fetchOpenCodeProjectsBounded("http://127.0.0.1:4096/project", options, async () => {
            throw new Error("network");
        });
        expect(network.status).toBe("transient");
    });
});
