import type { ProductionHostLaunchOptions } from "@oaam/app-server-bootstrap";
import { describe, expect, it, vi } from "vitest";
import { UtilityHostSupervisor, type UtilityProcessHandle, type UtilityTransferPort } from "../src/main/utility-host-supervisor";

class FakeProcess implements UtilityProcessHandle {
    readonly messages: Array<{ readonly message: unknown; readonly transfer: readonly UtilityTransferPort[] }> = [];
    readonly messageListeners: Array<(message: unknown) => void> = [];
    readonly exitListeners: Array<(code: number) => void> = [];
    killed = false;
    killCount = 0;
    throwOnPost = false;
    killResult = true;

    public onMessage(listener: (message: unknown) => void): () => void {
        this.messageListeners.push(listener);
        return () => undefined;
    }

    public onExit(listener: (code: number) => void): () => void {
        this.exitListeners.push(listener);
        return () => undefined;
    }

    public postMessage(message: never, transfer: readonly UtilityTransferPort[] = []): void {
        if (this.throwOnPost) throw new Error("post failed");
        this.messages.push({ message, transfer });
    }

    public kill(): boolean {
        this.killed = true;
        this.killCount += 1;
        return this.killResult;
    }

    public emitMessage(message: unknown): void {
        for (const listener of this.messageListeners) listener(message);
    }

    public emitExit(code: number): void {
        for (const listener of this.exitListeners) listener(code);
    }
}

function port() {
    return { close: vi.fn() };
}

function readyEvent(
    hostInstanceId: string,
    startupDisposition:
        | { readonly mode: "normal" }
        | {
              readonly mode: "state_recovery";
              readonly reason: "missing_database" | "corrupt_database" | "incompatible_database" | "restore_reconciliation";
          } = { mode: "normal" },
) {
    return { type: "ready" as const, hostInstanceId, startupDisposition };
}

class FakeClock {
    #now = 0;
    #nextId = 0;
    readonly #tasks = new Map<object, { readonly due: number; readonly callback: () => void }>();

    public schedule = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
        const handle = { id: this.#nextId++, unref: vi.fn() };
        this.#tasks.set(handle, { due: this.#now + delayMs, callback });
        return handle as unknown as ReturnType<typeof setTimeout>;
    };

    public cancel = (handle: ReturnType<typeof setTimeout>): void => {
        this.#tasks.delete(handle as unknown as object);
    };

    public advanceBy(delayMs: number): void {
        const target = this.#now + delayMs;
        while (true) {
            const next = [...this.#tasks.entries()]
                .filter(([, task]) => task.due <= target)
                .sort((left, right) => left[1].due - right[1].due)[0];
            if (next === undefined) break;
            const [handle, task] = next;
            this.#tasks.delete(handle);
            this.#now = task.due;
            task.callback();
        }
        this.#now = target;
    }
}

const options: ProductionHostLaunchOptions = {
    oaamRoot: "/state",
    platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
};

describe("Desktop utility Host supervisor", () => {
    it("defers launch-option discovery until start and refreshes it for the one replacement", () => {
        const first = new FakeProcess();
        const replacement = new FakeProcess();
        const children = [first, replacement];
        const createLaunchOptions = vi.fn(() => options);
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => {
                    const child = children.shift();
                    if (child === undefined) throw new Error("unexpected extra Host process");
                    return child;
                },
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
            },
            createLaunchOptions,
        );

        expect(createLaunchOptions).not.toHaveBeenCalled();
        supervisor.start();
        expect(createLaunchOptions).toHaveBeenCalledOnce();
        first.emitExit(7);
        expect(createLaunchOptions).toHaveBeenCalledTimes(2);
        expect(replacement.messages[0]?.message).toEqual({ type: "boot", options });
    });

    it("fails closed without spawning when deferred launch-option discovery fails", () => {
        const spawn = vi.fn(() => new FakeProcess());
        const createLaunchOptions = vi.fn(() => {
            throw new Error("environment discovery failed");
        });
        const supervisor = new UtilityHostSupervisor(
            {
                spawn,
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
            },
            createLaunchOptions,
        );

        supervisor.start();
        expect(supervisor.state).toBe("failed");
        expect(createLaunchOptions).toHaveBeenCalledTimes(2);
        expect(spawn).not.toHaveBeenCalled();
    });

    it("rejects invalid startup timing and fails closed after two synchronous spawn failures", () => {
        const dependencies = {
            spawn: () => {
                throw new Error("spawn failed");
            },
            createChannel: () => ({ hostPort: port(), clientPort: port() }),
        };
        expect(() => new UtilityHostSupervisor(dependencies, options, { startupCheckMs: 0 })).toThrow(
            /positive check before its deadline/u,
        );
        expect(() => new UtilityHostSupervisor(dependencies, options, { startupCheckMs: 10, startupDeadlineMs: 10 })).toThrow(
            /positive check before its deadline/u,
        );

        const supervisor = new UtilityHostSupervisor(dependencies, options);
        supervisor.start();
        expect(supervisor.state).toBe("failed");
        supervisor.shutdown();
        expect(supervisor.state).toBe("stopped");
    });

    it("uses its one replacement when only the first synchronous spawn fails", () => {
        const replacement = new FakeProcess();
        let attempts = 0;
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => {
                    attempts += 1;
                    if (attempts === 1) throw new Error("first spawn failed");
                    return replacement;
                },
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
            },
            options,
        );
        supervisor.start();
        replacement.emitMessage(readyEvent("replacement"));
        expect(attempts).toBe(2);
        expect(supervisor.state).toBe("ready");
    });

    it("preserves the exact recovery disposition only on the ready Host event", () => {
        const child = new FakeProcess();
        const events: unknown[] = [];
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => child,
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
            },
            options,
        );
        supervisor.subscribe((event) => events.push(event));
        supervisor.start();
        child.emitMessage(readyEvent("recovery-host", { mode: "state_recovery", reason: "incompatible_database" }));

        expect(events.at(-1)).toEqual({
            state: "ready",
            hostInstanceId: "recovery-host",
            reasonCode: "",
            startupDisposition: { mode: "state_recovery", reason: "incompatible_database" },
        });
        expect(events.slice(0, -1)).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ startupDisposition: expect.anything() })]),
        );
    });

    it("checks a hung startup at ten seconds and waits for exact exit before its one replacement", () => {
        const clock = new FakeClock();
        const children = [new FakeProcess(), new FakeProcess()];
        const [first, replacement] = children;
        if (first === undefined || replacement === undefined) throw new Error("test fixture is incomplete");
        let spawnCount = 0;
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => {
                    const child = children[spawnCount++];
                    if (child === undefined) throw new Error("unexpected extra Host process");
                    return child;
                },
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
                schedule: clock.schedule,
                cancel: clock.cancel,
            },
            options,
        );
        const events: unknown[] = [];
        supervisor.subscribe((event) => events.push(event));

        supervisor.start();
        clock.advanceBy(9_999);
        expect(first.killed).toBe(false);
        clock.advanceBy(1);
        expect(first.killed).toBe(true);
        expect(spawnCount).toBe(1);
        expect(events.at(-1)).toEqual({
            state: "starting",
            hostInstanceId: "",
            reasonCode: "host.startup_liveness_timeout",
        });

        first.emitExit(7);
        expect(spawnCount).toBe(2);
        expect(events.at(-1)).toEqual({
            state: "starting",
            hostInstanceId: "",
            reasonCode: "host.startup_recovering",
        });
        replacement.emitMessage(readyEvent("replacement"));
        clock.advanceBy(30_000);
        expect(supervisor.state).toBe("ready");
        expect(replacement.killed).toBe(false);
    });

    it("surfaces a terminal failure by thirty seconds without starting a third process", () => {
        const clock = new FakeClock();
        const children = [new FakeProcess(), new FakeProcess()];
        const [first, replacement] = children;
        if (first === undefined || replacement === undefined) throw new Error("test fixture is incomplete");
        let spawnCount = 0;
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => {
                    const child = children[spawnCount++];
                    if (child === undefined) throw new Error("unexpected extra Host process");
                    return child;
                },
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
                schedule: clock.schedule,
                cancel: clock.cancel,
            },
            options,
        );
        const events: unknown[] = [];
        supervisor.subscribe((event) => events.push(event));

        supervisor.start();
        clock.advanceBy(10_000);
        first.emitExit(7);
        clock.advanceBy(20_000);
        expect(spawnCount).toBe(2);
        expect(supervisor.state).toBe("failed");
        expect(replacement.killed).toBe(true);
        expect(events.at(-1)).toEqual({
            state: "failed",
            hostInstanceId: "",
            reasonCode: "host.startup_timeout",
        });
        replacement.emitExit(7);
        expect(spawnCount).toBe(2);
        expect(supervisor.state).toBe("failed");
    });

    it("boots, transfers a keyed channel, registers a native path on that connection, drains and shuts down", async () => {
        const child = new FakeProcess();
        const hostPort = port();
        const clientPort = port();
        const diagnosticHostPort = port();
        const diagnosticClientPort = port();
        const channels = [
            { hostPort, clientPort },
            { hostPort: diagnosticHostPort, clientPort: diagnosticClientPort },
        ];
        const controlIds = ["connection-1", "connection-2", "request-1"];
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => child,
                createChannel: () => channels.shift() ?? { hostPort: port(), clientPort: port() },
                createControlId: () => controlIds.shift() ?? "unexpected-id",
            },
            options,
        );
        const events: unknown[] = [];
        const unsubscribe = supervisor.subscribe((event) => events.push(event));
        supervisor.start();
        expect(child.messages[0]).toEqual({ message: { type: "boot", options }, transfer: [] });
        child.emitMessage(readyEvent("host-1"));
        expect(supervisor.state).toBe("ready");
        expect(supervisor.connect()).toBe(clientPort);
        expect(child.messages.at(-1)).toEqual({
            message: { type: "connect", connectionKey: "connection-1" },
            transfer: [hostPort],
        });
        expect(supervisor.connect({ claimPathSelectionAuthority: false })).toBe(diagnosticClientPort);
        expect(child.messages.at(-1)).toEqual({
            message: { type: "connect", connectionKey: "connection-2" },
            transfer: [diagnosticHostPort],
        });
        const registration = supervisor.registerLocalPathSelection("project_root", "/project");
        expect(child.messages.at(-1)).toEqual({
            message: {
                type: "register_local_path",
                requestId: "request-1",
                connectionKey: "connection-1",
                kind: "project_root",
                rootPath: "/project",
            },
            transfer: [],
        });
        child.emitMessage({ type: "local_path_registered", requestId: "request-1", token: "token-1" });
        await expect(registration).resolves.toBe("token-1");
        supervisor.drain();
        expect(supervisor.state).toBe("draining");
        child.emitMessage({ type: "drained" });
        supervisor.shutdown();
        child.emitMessage({ type: "stopped" });
        child.emitExit(0);
        expect(supervisor.state).toBe("stopped");
        expect(events).toContainEqual({
            state: "ready",
            hostInstanceId: "host-1",
            reasonCode: "",
            startupDisposition: { mode: "normal" },
        });
        unsubscribe();
    });

    it("allows one automatic replacement and then requires an explicit retry", () => {
        const children = [new FakeProcess(), new FakeProcess(), new FakeProcess()];
        const [first, second, third] = children;
        if (first === undefined || second === undefined || third === undefined) throw new Error("test fixture is incomplete");
        let index = 0;
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => {
                    const child = children[index++];
                    if (child === undefined) throw new Error("unexpected extra Host process");
                    return child;
                },
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
            },
            options,
        );
        supervisor.start();
        first.emitExit(7);
        expect(index).toBe(2);
        second.emitExit(7);
        expect(supervisor.state).toBe("failed");
        supervisor.retry();
        expect(index).toBe(3);
        third.emitMessage(readyEvent("replacement"));
        expect(supervisor.state).toBe("ready");
        supervisor.shutdown();
        third.emitMessage({ type: "stopped" });
        third.emitExit(0);
        expect(supervisor.state).toBe("stopped");
    });

    it("fails closed for invalid events, duplicate ready, unavailable connect and boot delivery failure", () => {
        const first = new FakeProcess();
        const second = new FakeProcess();
        second.throwOnPost = true;
        let useSecond = false;
        const hostPort = port();
        const clientPort = port();
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => (useSecond ? second : first),
                createChannel: () => ({ hostPort, clientPort }),
            },
            options,
        );
        expect(() => supervisor.connect()).toThrow(/not ready/u);
        supervisor.start();
        expect(() => supervisor.start()).toThrow(/already active/u);
        first.emitMessage({ type: "not-an-event" });
        expect(first.killed).toBe(true);
        expect(supervisor.state).toBe("starting");

        useSecond = true;
        first.emitExit(7);
        expect(second.killed).toBe(true);
        second.emitExit(7);
        expect(supervisor.state).toBe("failed");

        const third = new FakeProcess();
        const readySupervisor = new UtilityHostSupervisor(
            {
                spawn: () => third,
                createChannel: () => ({ hostPort, clientPort }),
            },
            options,
        );
        readySupervisor.start();
        third.emitMessage(readyEvent("first"));
        third.emitMessage(readyEvent("duplicate"));
        expect(third.killed).toBe(true);
        expect(readySupervisor.state).toBe("starting");
    });

    it("kills a failed Host before replacement and preserves the second failure reason", () => {
        const children = [new FakeProcess(), new FakeProcess()];
        const [first, second] = children;
        if (first === undefined || second === undefined) throw new Error("test fixture is incomplete");
        let index = 0;
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => {
                    const child = children[index++];
                    if (child === undefined) throw new Error("unexpected extra Host process");
                    return child;
                },
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
            },
            options,
        );
        const events: unknown[] = [];
        supervisor.subscribe((event) => events.push(event));

        supervisor.start();
        first.emitMessage({ type: "failure", phase: "startup", code: "host.startup_failed" });
        expect(first.killed).toBe(true);
        expect(index).toBe(1);
        first.emitExit(7);
        expect(index).toBe(2);
        second.emitMessage({ type: "failure", phase: "control", code: "host.control_failed" });
        expect(second.killed).toBe(true);
        second.emitExit(7);
        expect(supervisor.state).toBe("failed");
        expect(events.at(-1)).toEqual({
            state: "failed",
            hostInstanceId: "",
            reasonCode: "host.control_failed",
        });
    });

    it("treats an unsolicited stopped event as a failed Host instead of a graceful shutdown", () => {
        const children = [new FakeProcess(), new FakeProcess()];
        const [first, second] = children;
        if (first === undefined || second === undefined) throw new Error("test fixture is incomplete");
        let index = 0;
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => {
                    const child = children[index++];
                    if (child === undefined) throw new Error("unexpected extra Host process");
                    return child;
                },
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
            },
            options,
        );

        supervisor.start();
        first.emitMessage(readyEvent("host-1"));
        first.emitMessage({ type: "stopped" });

        expect(first.killed).toBe(true);
        expect(supervisor.state).toBe("starting");
        first.emitExit(7);
        expect(index).toBe(2);
        second.emitMessage(readyEvent("host-2"));
        expect(supervisor.state).toBe("ready");
    });

    it("retains shutdown delivery failure while drain delivery still follows its failure path", () => {
        const drainChild = new FakeProcess();
        const drainSupervisor = new UtilityHostSupervisor(
            {
                spawn: () => drainChild,
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
            },
            options,
        );
        drainSupervisor.start();
        drainChild.emitMessage(readyEvent("host-1"));
        drainChild.throwOnPost = true;
        drainSupervisor.drain();
        expect(drainChild.killed).toBe(true);
        expect(drainSupervisor.state).toBe("starting");

        const shutdownChild = new FakeProcess();
        const shutdownSupervisor = new UtilityHostSupervisor(
            {
                spawn: () => shutdownChild,
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
            },
            options,
        );
        shutdownSupervisor.start();
        shutdownChild.emitMessage(readyEvent("host-2"));
        shutdownChild.throwOnPost = true;
        shutdownSupervisor.shutdown();
        expect(shutdownChild.killed).toBe(false);
        expect(shutdownSupervisor.state).toBe("failed");
        shutdownChild.emitExit(7);
        expect(shutdownSupervisor.state).toBe("failed");
    });

    it("closes both ports if connection transfer throws", () => {
        const child = new FakeProcess();
        const hostPort = port();
        const clientPort = port();
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => child,
                createChannel: () => ({ hostPort, clientPort }),
            },
            options,
        );
        supervisor.start();
        child.emitMessage(readyEvent("host"));
        child.throwOnPost = true;
        expect(() => supervisor.connect()).toThrow("post failed");
        expect(hostPort.close).toHaveBeenCalledOnce();
        expect(clientPort.close).toHaveBeenCalledOnce();
    });

    it("rejects bounded path-registration failures and pending work on Host exit", async () => {
        const first = new FakeProcess();
        const second = new FakeProcess();
        const controlIds = ["connection-1", "request-1", "request-2"];
        let child = first;
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => child,
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
                createControlId: () => controlIds.shift() ?? "fallback",
            },
            options,
        );
        await expect(supervisor.registerLocalPathSelection("project_root", "/project")).rejects.toThrow(/unavailable/u);
        supervisor.start();
        first.emitMessage(readyEvent("host-1"));
        supervisor.connect();
        const denied = supervisor.registerLocalPathSelection("project_root", "/denied");
        first.emitMessage({
            type: "local_path_registration_failed",
            requestId: "request-1",
            code: "host.path_registration_failed",
        });
        await expect(denied).rejects.toThrow("host.path_registration_failed");

        const pending = supervisor.registerLocalPathSelection("project_root", "/pending");
        child = second;
        first.emitExit(7);
        await expect(pending).rejects.toThrow(/exited/u);
        expect(supervisor.state).toBe("starting");
    });

    it("bounds path delivery, invalid control ids and failed process termination", async () => {
        const deliveryChild = new FakeProcess();
        const delivery = new UtilityHostSupervisor(
            {
                spawn: () => deliveryChild,
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
                createControlId: () => "connection",
            },
            options,
        );
        delivery.start();
        deliveryChild.emitMessage(readyEvent("host"));
        delivery.connect();
        deliveryChild.throwOnPost = true;
        await expect(delivery.registerLocalPathSelection("project_root", "/project")).rejects.toThrow(/could not be delivered/u);

        const invalidIdChild = new FakeProcess();
        const invalidIds = new UtilityHostSupervisor(
            {
                spawn: () => invalidIdChild,
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
                createControlId: () => "",
            },
            options,
        );
        invalidIds.start();
        invalidIdChild.emitMessage(readyEvent("host"));
        expect(() => invalidIds.connect()).toThrow(/allocate a control id/u);

        const unkillable = new FakeProcess();
        unkillable.killResult = false;
        let spawnCount = 0;
        const termination = new UtilityHostSupervisor(
            {
                spawn: () => {
                    spawnCount += 1;
                    return unkillable;
                },
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
            },
            options,
        );
        termination.start();
        unkillable.emitMessage({ type: "failure", phase: "startup", code: "host.startup_failed" });
        expect(termination.state).toBe("failed");
        expect(unkillable.killed).toBe(true);
        expect(() => termination.retry()).toThrow(/requires the failed process to be terminated/u);
        expect(() => termination.start()).toThrow(/already active/u);
        expect(spawnCount).toBe(1);
    });

    it("resolves exact State backup files and rejects unavailable, failed, undelivered and interrupted requests", async () => {
        const child = new FakeProcess();
        const controlIds = ["resolve-1", "resolve-2", "resolve-3", "resolve-4"];
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => child,
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
                createControlId: () => controlIds.shift() ?? "fallback",
            },
            options,
        );
        const backupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

        await expect(supervisor.resolveStateBackupFile(backupId)).rejects.toThrow(/not ready/u);
        supervisor.start();
        child.emitMessage(readyEvent("host"));

        const resolved = supervisor.resolveStateBackupFile(backupId);
        expect(child.messages.at(-1)?.message).toEqual({
            type: "resolve_state_backup_file",
            requestId: "resolve-1",
            backupId,
        });
        child.emitMessage({
            type: "state_backup_file_resolved",
            requestId: "resolve-1",
            archivePath: "/state/backups/one.zip",
        });
        await expect(resolved).resolves.toBe("/state/backups/one.zip");

        const denied = supervisor.resolveStateBackupFile(backupId);
        child.emitMessage({
            type: "state_backup_file_resolution_failed",
            requestId: "resolve-2",
            code: "host.state_backup_file_unavailable",
        });
        await expect(denied).rejects.toThrow("host.state_backup_file_unavailable");

        child.throwOnPost = true;
        await expect(supervisor.resolveStateBackupFile(backupId)).rejects.toThrow(/could not be delivered/u);
        child.throwOnPost = false;

        const interrupted = supervisor.resolveStateBackupFile(backupId);
        const interruptedExpectation = expect(interrupted).rejects.toThrow(/stopped/u);
        supervisor.shutdown();
        child.emitMessage({ type: "stopped" });
        child.emitExit(0);
        await interruptedExpectation;
        expect(supervisor.state).toBe("stopped");
    });

    it("coordinates finite State backup mutations and rejects unavailable, failed, undelivered and interrupted work", async () => {
        const child = new FakeProcess();
        const controlIds = ["mutate-1", "mutate-2", "mutate-3", "mutate-4"];
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => child,
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
                createControlId: () => controlIds.shift() ?? "fallback",
            },
            options,
        );
        const backupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

        await expect(
            supervisor.mutateStateBackupFile(backupId, "identity_bound_trash", "user-action-unavailable"),
        ).rejects.toThrow(/not ready/u);
        supervisor.start();
        child.emitMessage(readyEvent("host"));

        const recycled = supervisor.mutateStateBackupFile(backupId, "identity_bound_trash", "user-action-trash");
        expect(child.messages.at(-1)?.message).toEqual({
            type: "mutate_state_backup_file",
            requestId: "mutate-1",
            backupId,
            action: "identity_bound_trash",
            userActionId: "user-action-trash",
        });
        child.emitMessage({ type: "state_backup_file_mutation_complete", requestId: "mutate-1" });
        await expect(recycled).resolves.toBeUndefined();

        const denied = supervisor.mutateStateBackupFile(backupId, "retire_missing", "user-action-retire");
        child.emitMessage({
            type: "state_backup_file_mutation_failed",
            requestId: "mutate-2",
            code: "host.state_backup_file_mutation_failed",
        });
        await expect(denied).rejects.toThrow("host.state_backup_file_mutation_failed");

        child.throwOnPost = true;
        await expect(
            supervisor.mutateStateBackupFile(backupId, "identity_bound_trash", "user-action-undelivered"),
        ).rejects.toThrow(/could not be delivered/u);
        child.throwOnPost = false;

        const interrupted = supervisor.mutateStateBackupFile(backupId, "identity_bound_trash", "user-action-interrupted");
        const interruptedExpectation = expect(interrupted).rejects.toThrow(/stopped/u);
        supervisor.shutdown();
        child.emitMessage({ type: "stopped" });
        child.emitExit(0);
        await interruptedExpectation;
        expect(supervisor.state).toBe("stopped");
    });

    it("times out an unanswered State backup mutation without retaining the request", async () => {
        vi.useFakeTimers();
        try {
            const child = new FakeProcess();
            const supervisor = new UtilityHostSupervisor(
                {
                    spawn: () => child,
                    createChannel: () => ({ hostPort: port(), clientPort: port() }),
                    createControlId: () => "mutation-timeout",
                },
                options,
            );
            supervisor.start();
            child.emitMessage(readyEvent("host"));
            const pending = supervisor.mutateStateBackupFile(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "identity_bound_trash",
                "user-action-timeout",
            );
            const timeoutExpectation = expect(pending).rejects.toThrow(/timed out/u);
            await vi.advanceTimersByTimeAsync(5_000);
            await timeoutExpectation;

            child.emitMessage({
                type: "state_backup_file_mutation_complete",
                requestId: "mutation-timeout",
            });
            expect(child.killed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("serves Desktop preference backup and restore requests with copied bytes and bounded failures", async () => {
        const sourceBytes = new Uint8Array([1, 2, 3]);
        const readDesktopPreferences = vi
            .fn<() => Promise<Uint8Array>>()
            .mockResolvedValueOnce(sourceBytes)
            .mockRejectedValueOnce(new Error("read failed"));
        const applyRestoredDesktopPreferences = vi
            .fn<(bytes: Uint8Array, restoreTransactionPath: string) => Promise<void>>()
            .mockResolvedValueOnce()
            .mockRejectedValueOnce(new Error("write failed"));
        const child = new FakeProcess();
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => child,
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
                readDesktopPreferences,
                applyRestoredDesktopPreferences,
            },
            options,
        );
        supervisor.start();
        child.emitMessage(readyEvent("host"));

        child.emitMessage({ type: "desktop_preferences_read_requested", requestId: "read-1" });
        await vi.waitFor(() => {
            expect(child.messages.at(-1)?.message).toEqual({
                type: "desktop_preferences_read_result",
                requestId: "read-1",
                status: "complete",
                bytes: new Uint8Array([1, 2, 3]),
            });
        });
        sourceBytes[0] = 9;
        expect((child.messages.at(-1)?.message as { readonly bytes: Uint8Array }).bytes).toEqual(new Uint8Array([1, 2, 3]));

        child.emitMessage({ type: "desktop_preferences_read_requested", requestId: "read-2" });
        await vi.waitFor(() => {
            expect(child.messages.at(-1)?.message).toEqual({
                type: "desktop_preferences_read_result",
                requestId: "read-2",
                status: "failed",
                code: "desktop.preferences_read_failed",
            });
        });

        const restoreBytes = new Uint8Array([4, 5, 6]);
        child.emitMessage({
            type: "desktop_preferences_restore_requested",
            requestId: "restore-1",
            bytes: restoreBytes,
            restoreTransactionPath: "/state/.restore-1",
        });
        restoreBytes[0] = 0;
        await vi.waitFor(() => {
            expect(applyRestoredDesktopPreferences).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]), "/state/.restore-1");
            expect(child.messages.at(-1)?.message).toEqual({
                type: "desktop_preferences_restore_result",
                requestId: "restore-1",
                status: "complete",
            });
        });

        child.emitMessage({
            type: "desktop_preferences_restore_requested",
            requestId: "restore-2",
            bytes: new Uint8Array([7]),
            restoreTransactionPath: "/state/.restore-2",
        });
        await vi.waitFor(() => {
            expect(child.messages.at(-1)?.message).toEqual({
                type: "desktop_preferences_restore_result",
                requestId: "restore-2",
                status: "failed",
                code: "desktop.preferences_restore_failed",
            });
        });
    });

    it("fails preference requests without an owner and terminates a Host that cannot receive the answer", async () => {
        const unavailable = new FakeProcess();
        const unavailableSupervisor = new UtilityHostSupervisor(
            {
                spawn: () => unavailable,
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
            },
            options,
        );
        unavailableSupervisor.start();
        unavailable.emitMessage(readyEvent("host"));
        unavailable.emitMessage({ type: "desktop_preferences_read_requested", requestId: "read" });
        await vi.waitFor(() => {
            expect(unavailable.messages.at(-1)?.message).toMatchObject({
                type: "desktop_preferences_read_result",
                status: "failed",
            });
        });
        unavailable.emitMessage({
            type: "desktop_preferences_restore_requested",
            requestId: "restore",
            bytes: new Uint8Array(),
            restoreTransactionPath: "/state/.restore",
        });
        await vi.waitFor(() => {
            expect(unavailable.messages.at(-1)?.message).toMatchObject({
                type: "desktop_preferences_restore_result",
                status: "failed",
            });
        });

        const undeliverable = new FakeProcess();
        const deliverySupervisor = new UtilityHostSupervisor(
            {
                spawn: () => undeliverable,
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
                readDesktopPreferences: async () => new Uint8Array([1]),
            },
            options,
        );
        deliverySupervisor.start();
        undeliverable.emitMessage(readyEvent("host"));
        undeliverable.throwOnPost = true;
        undeliverable.emitMessage({ type: "desktop_preferences_read_requested", requestId: "read" });
        await vi.waitFor(() => expect(undeliverable.killed).toBe(true));
        expect(deliverySupervisor.state).toBe("starting");
    });

    it("fails closed on unsolicited backup-file results and ignores late preference reads from a replaced Host", async () => {
        let completeRead: ((bytes: Uint8Array) => void) | undefined;
        const readDesktopPreferences = vi.fn(
            () =>
                new Promise<Uint8Array>((resolve) => {
                    completeRead = resolve;
                }),
        );
        const first = new FakeProcess();
        const replacement = new FakeProcess();
        const children = [first, replacement];
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => {
                    const child = children.shift();
                    if (child === undefined) throw new Error("unexpected extra Host process");
                    return child;
                },
                createChannel: () => ({ hostPort: port(), clientPort: port() }),
                readDesktopPreferences,
            },
            options,
        );
        supervisor.start();
        first.emitMessage(readyEvent("first"));
        first.emitMessage({ type: "desktop_preferences_read_requested", requestId: "late" });
        first.emitExit(7);
        replacement.emitMessage(readyEvent("replacement"));
        completeRead?.(new Uint8Array([1]));
        await Promise.resolve();
        expect(first.messages.some(({ message }) => (message as { readonly requestId?: string }).requestId === "late")).toBe(
            false,
        );

        replacement.emitMessage({
            type: "state_backup_file_resolved",
            requestId: "not-pending",
            archivePath: "/state/backups/one.zip",
        });
        expect(replacement.killed).toBe(true);
        expect(supervisor.state).toBe("starting");
    });
});
