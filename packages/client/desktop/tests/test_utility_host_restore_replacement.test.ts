import { describe, expect, it, vi } from "vitest";
import { UtilityHostSupervisor, type UtilityProcessHandle } from "../src/main/utility-host-supervisor";

function childFixture() {
    let receive: (message: unknown) => void = () => undefined;
    let exit: (code: number) => void = () => undefined;
    const child: UtilityProcessHandle = {
        onMessage: (listener) => {
            receive = listener;
        },
        onExit: (listener) => {
            exit = listener;
        },
        postMessage: vi.fn(),
        kill: vi.fn(() => true),
    };
    return { child, receive: (message: unknown) => receive(message), exit: (code: number) => exit(code) };
}

function fixture(ready = true) {
    const first = childFixture(),
        replacement = childFixture();
    const spawn = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(replacement.child);
    const supervisor = new UtilityHostSupervisor(
        {
            spawn,
            createChannel: () => {
                throw new Error("no renderer in lifecycle control");
            },
        },
        { oaamRoot: "/owned/oaam", platformContexts: [{ platform: "linux", platformInstanceId: "", accessRootPath: "/" }] },
    );
    supervisor.start();
    if (ready) first.receive({ type: "ready", hostInstanceId: "first", startupDisposition: { mode: "normal" } });
    return { supervisor, first, replacement, spawn };
}

describe("restore replacement waits for released resources and old Host exit", () => {
    it("sends shutdown without killing and starts the replacement only after acknowledgement plus actual exit", () => {
        const f = fixture();
        f.first.receive({ type: "restore_replacement_required" });
        expect(f.first.child.kill).not.toHaveBeenCalled();
        expect(f.first.child.postMessage).toHaveBeenCalledWith({ type: "shutdown" });
        expect(f.supervisor.state).toBe("draining");
        expect(f.spawn).toHaveBeenCalledOnce();
        f.first.receive({ type: "stopped" });
        expect(f.spawn).toHaveBeenCalledOnce();
        f.first.exit(0);
        expect(f.spawn).toHaveBeenCalledTimes(2);
        f.replacement.receive({ type: "ready", hostInstanceId: "replacement", startupDisposition: { mode: "normal" } });
        expect(f.supervisor.state).toBe("ready");
    });

    it.each([
        "delivery",
        "release",
        "exit_without_ack",
    ] as const)("retains %s failure without replacing an uncertain owner", (failure) => {
        const f = fixture();
        if (failure === "delivery")
            vi.mocked(f.first.child.postMessage).mockImplementation(() => {
                throw new Error("closed");
            });
        f.first.receive({ type: "restore_replacement_required" });
        if (failure === "release") f.first.receive({ type: "failure", phase: "shutdown", code: "host.shutdown_failed" });
        f.first.exit(0);
        expect(f.first.child.kill).not.toHaveBeenCalled();
        expect(f.supervisor.state).toBe("failed");
        expect(f.spawn).toHaveBeenCalledOnce();
    });

    it.each([false, true])("a user quit cancels replacement even when the release receipt has arrived: %s", (acknowledged) => {
        const f = fixture();
        f.first.receive({ type: "restore_replacement_required" });
        if (acknowledged) f.first.receive({ type: "stopped" });
        f.supervisor.shutdown();
        if (!acknowledged) f.first.receive({ type: "stopped" });
        f.first.exit(0);
        expect(f.supervisor.state).toBe("stopped");
        expect(f.spawn).toHaveBeenCalledOnce();
        expect(vi.mocked(f.first.child.postMessage).mock.calls.filter(([message]) => message.type === "shutdown")).toHaveLength(
            1,
        );
    });

    it("rejects a restore replacement event before the original Host is ready", () => {
        const f = fixture(false);
        f.first.receive({ type: "restore_replacement_required" });
        expect(f.first.child.kill).toHaveBeenCalledOnce();
        f.first.exit(7);
        f.replacement.exit(7);
        expect(f.supervisor.state).toBe("failed");
    });
});
