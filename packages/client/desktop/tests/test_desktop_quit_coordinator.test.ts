import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopQuitCoordinator } from "../src/main/desktop-quit-coordinator";
import { UtilityHostSupervisor, type UtilityProcessHandle } from "../src/main/utility-host-supervisor";

function fixture(finishPerformance: () => Promise<void> = async () => undefined, hostDeadlineMs = 60_000) {
    let receive: (value: unknown) => void = () => undefined;
    let exit: (code: number) => void = () => undefined;
    const makeChild = (): UtilityProcessHandle => ({
        onMessage: (listener) => {
            receive = listener;
        },
        onExit: (listener) => {
            exit = listener;
        },
        postMessage: vi.fn(),
        kill: vi.fn(() => true),
    });
    let child = makeChild();
    const supervisor = new UtilityHostSupervisor(
        {
            spawn: () => {
                child = makeChild();
                return child;
            },
            createChannel: () => {
                throw new Error("no renderer connection in quit test");
            },
        },
        { oaamRoot: "/owned/oaam", platformContexts: [{ platform: "linux", platformInstanceId: "", accessRootPath: "/" }] },
    );
    supervisor.start();
    receive({ type: "ready", hostInstanceId: "quit-host", startupDisposition: { mode: "normal" } });
    const onStopped = vi.fn();
    const onFailure = vi.fn();
    const onStart = vi.fn();
    const onPerformanceFailure = vi.fn();
    const performance = vi.fn(finishPerformance);
    const coordinator = new DesktopQuitCoordinator({
        finishPerformance: performance,
        hostState: () => supervisor.state,
        subscribeHost: (listener) => supervisor.subscribe(listener),
        shutdownHost: () => supervisor.shutdown(),
        onStopped,
        onFailure,
        onStart,
        onPerformanceFailure,
        hostDeadlineMs,
    });
    const request = () => {
        const event = { preventDefault: vi.fn() };
        coordinator.beforeQuit(event);
        return event;
    };
    return {
        supervisor,
        get child() {
            return child;
        },
        receive: (value: unknown) => receive(value),
        exit: (code: number) => exit(code),
        onStopped,
        onFailure,
        onStart,
        onPerformanceFailure,
        performance,
        request,
    };
}

describe("Desktop quit waits for actual Host cleanup", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("waits beyond two seconds and sends only one shutdown for repeated quit requests", async () => {
        const f = fixture();
        expect(f.request().preventDefault).toHaveBeenCalledOnce();
        f.request();
        await vi.advanceTimersByTimeAsync(5_000);
        f.request();
        expect(f.onStopped).not.toHaveBeenCalled();
        expect(f.supervisor.state).toBe("draining");
        expect(f.onStart).toHaveBeenCalledOnce();
        expect(f.performance).toHaveBeenCalledOnce();
        expect(vi.mocked(f.child.postMessage).mock.calls.filter(([message]) => message.type === "shutdown")).toHaveLength(1);
        f.receive({ type: "stopped" });
        expect(f.supervisor.state).toBe("draining");
        f.exit(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.onStopped).toHaveBeenCalledOnce();
        expect(f.onFailure).not.toHaveBeenCalled();
        expect(f.request().preventDefault).not.toHaveBeenCalled();
    });

    it("performance timeout starts Host cleanup without authorizing an early app exit", async () => {
        let finish: () => void = () => undefined;
        const recording = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const f = fixture(() => recording);
        f.request();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.onPerformanceFailure).toHaveBeenCalledOnce();
        expect(f.supervisor.state).toBe("draining");
        expect(f.onStopped).not.toHaveBeenCalled();
        finish();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(f.onStopped).not.toHaveBeenCalled();
        f.receive({ type: "stopped" });
        f.exit(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.onStopped).toHaveBeenCalledOnce();
    });

    it("records rejected performance finalization and still waits for Host acknowledgement", async () => {
        const f = fixture(async () => {
            throw new Error("trace could not finish");
        });
        f.request();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.onPerformanceFailure).toHaveBeenCalledOnce();
        expect(f.onStopped).not.toHaveBeenCalled();
        f.receive({ type: "stopped" });
        f.exit(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.onStopped).toHaveBeenCalledOnce();
    });

    it("preserves cleanup rejection through failure, repeated quit and utility-process exit", async () => {
        const f = fixture();
        f.request();
        await vi.advanceTimersByTimeAsync(0);
        f.receive({ type: "failure", phase: "shutdown", code: "host.shutdown_failed" });
        await vi.advanceTimersByTimeAsync(0);
        expect(f.supervisor.state).toBe("failed");
        expect(f.child.kill).not.toHaveBeenCalled();
        expect(f.onFailure).toHaveBeenCalledOnce();
        expect(f.onStopped).not.toHaveBeenCalled();
        expect(f.request().preventDefault).toHaveBeenCalledOnce();
        f.exit(7);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.supervisor.state).toBe("failed");
        expect(f.onStopped).not.toHaveBeenCalled();
    });

    it("does not accept an exit code of zero without a stopped receipt", async () => {
        const f = fixture();
        f.request();
        await vi.advanceTimersByTimeAsync(0);
        f.exit(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.supervisor.state).toBe("failed");
        expect(f.onFailure).toHaveBeenCalledOnce();
        expect(f.onStopped).not.toHaveBeenCalled();
    });

    it("reports a missing acknowledgement at the bound and permits a later user quit only after a real receipt", async () => {
        const f = fixture(async () => undefined, 3_000);
        f.request();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(f.onFailure).toHaveBeenCalledOnce();
        expect(f.onStopped).not.toHaveBeenCalled();
        expect(f.request().preventDefault).toHaveBeenCalledOnce();
        f.receive({ type: "stopped" });
        f.exit(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.onStopped).not.toHaveBeenCalled();
        expect(f.request().preventDefault).not.toHaveBeenCalled();
    });

    it("can quit a new ready Host after a failed shutdown and actual supervisor retry", async () => {
        const f = fixture();
        const failedChild = f.child;
        f.request();
        await vi.advanceTimersByTimeAsync(0);
        f.receive({ type: "failure", phase: "shutdown", code: "host.shutdown_failed" });
        f.exit(7);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.supervisor.state).toBe("failed");
        f.supervisor.retry();
        expect(f.child).not.toBe(failedChild);
        f.receive({ type: "ready", hostInstanceId: "retried-host", startupDisposition: { mode: "normal" } });
        f.request();
        f.request();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.supervisor.state).toBe("draining");
        expect(vi.mocked(f.child.postMessage).mock.calls.filter(([message]) => message.type === "shutdown")).toHaveLength(1);
        expect(f.performance).toHaveBeenCalledOnce();
        expect(f.onStart).toHaveBeenCalledTimes(2);
        f.receive({ type: "stopped" });
        expect(f.onStopped).not.toHaveBeenCalled();
        f.exit(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.onStopped).toHaveBeenCalledOnce();
        expect(f.request().preventDefault).not.toHaveBeenCalled();
    });
});
