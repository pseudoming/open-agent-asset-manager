import { describe, expect, it, vi } from "vitest";
import {
    DesktopRuntimeSmokeController,
    PACKAGED_RUNTIME_ONBOARDING_LINE,
    PACKAGED_RUNTIME_READY_LINE,
    PACKAGED_RUNTIME_SINGLE_INSTANCE_LINE,
    PACKAGED_RUNTIME_STOPPED_LINE,
} from "../src/main/packaged-runtime-smoke";

function probeFixture() {
    let complete: ((exitCode: number | null) => void) | undefined;
    const terminate = vi.fn();
    return {
        probe: {
            completed: new Promise<number | null>((resolve) => {
                complete = resolve;
            }),
            terminate,
        },
        complete(exitCode: number | null) {
            complete?.(exitCode);
        },
        terminate,
    };
}

function rejectingProbeFixture() {
    let fail: ((error: Error) => void) | undefined;
    const terminate = vi.fn();
    return {
        probe: {
            completed: new Promise<number | null>((_resolve, reject) => {
                fail = reject;
            }),
            terminate,
        },
        fail(error: Error) {
            fail?.(error);
        },
        terminate,
    };
}

function dependencies(probe = probeFixture()) {
    return {
        writeOutput: vi.fn(),
        writeError: vi.fn(),
        requestQuit: vi.fn(),
        proveOnboardingImport: vi.fn(async () => undefined),
        startSecondInstanceProbe: vi.fn(() => probe.probe),
    };
}

describe("packaged Desktop runtime smoke controller", () => {
    it("does nothing when the diagnostic switch is absent", () => {
        const deps = dependencies();
        const executeJavaScript = vi.fn();
        const controller = new DesktopRuntimeSmokeController(false, deps);
        controller.observeHostState("failed");
        controller.observe({ executeJavaScript });
        expect(executeJavaScript).not.toHaveBeenCalled();
        expect(deps.requestQuit).not.toHaveBeenCalled();
    });

    it("accepts only the exact ready projection and records graceful Host shutdown", async () => {
        const probe = probeFixture();
        const deps = dependencies(probe);
        const controller = new DesktopRuntimeSmokeController(true, deps);
        const executeJavaScript = vi.fn(async () => ({ state: "ready", assetCount: "0" }));
        controller.observeHostState("ready");
        controller.observe({ executeJavaScript });
        await vi.waitFor(() => expect(deps.startSecondInstanceProbe).toHaveBeenCalledOnce());
        expect(deps.requestQuit).not.toHaveBeenCalled();
        controller.secondInstanceObserved();
        probe.complete(0);
        await vi.waitFor(() => expect(deps.requestQuit).toHaveBeenCalledWith(false));
        expect(executeJavaScript.mock.calls[0]?.[0]).toContain("main[data-oaam-state]");
        expect(deps.writeOutput).toHaveBeenNthCalledWith(1, `${PACKAGED_RUNTIME_READY_LINE}\n`);
        expect(deps.writeOutput).toHaveBeenNthCalledWith(2, `${PACKAGED_RUNTIME_ONBOARDING_LINE}\n`);
        expect(deps.writeOutput).toHaveBeenNthCalledWith(3, `${PACKAGED_RUNTIME_SINGLE_INSTANCE_LINE}\n`);
        controller.hostStopped();
        expect(deps.writeOutput).toHaveBeenNthCalledWith(4, `${PACKAGED_RUNTIME_STOPPED_LINE}\n`);
        controller.observeHostState("failed");
        controller.dispose();
    });

    it("cancels a pending renderer poll when the packaged window is disposed", async () => {
        const deps = dependencies();
        const cancel = vi.fn();
        const unref = vi.fn();
        const handle = { unref } as unknown as ReturnType<typeof setTimeout>;
        const schedule = vi.fn(() => handle);
        const controller = new DesktopRuntimeSmokeController(true, { ...deps, cancel, schedule }, { timeoutMs: 60_000 });
        controller.observeHostState("starting");
        controller.observe({ executeJavaScript: async () => ({ state: "starting", assetCount: "" }) });
        await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
        expect(unref).toHaveBeenCalledOnce();
        controller.dispose();
        expect(cancel).toHaveBeenCalledWith(handle);
    });

    it("polls again after a starting projection and then accepts exact readiness", async () => {
        const probe = probeFixture();
        const deps = dependencies(probe);
        let scheduled: (() => void) | undefined;
        const schedule = vi.fn((callback: () => void) => {
            scheduled = callback;
            return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
        });
        const executeJavaScript = vi
            .fn()
            .mockResolvedValueOnce({ state: "starting", assetCount: "" })
            .mockResolvedValueOnce({ state: "ready", assetCount: "0" });
        const controller = new DesktopRuntimeSmokeController(true, { ...deps, schedule });
        controller.observeHostState("ready");
        controller.observe({ executeJavaScript });
        await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
        scheduled?.();
        await vi.waitFor(() => expect(deps.startSecondInstanceProbe).toHaveBeenCalledOnce());
        controller.secondInstanceObserved();
        probe.complete(0);
        await vi.waitFor(() => expect(deps.requestQuit).toHaveBeenCalledWith(false));
        expect(executeJavaScript).toHaveBeenCalledTimes(2);
        controller.hostStopped();
    });

    it("waits for both the primary event and successful competing-process exit", async () => {
        const probe = probeFixture();
        const deps = dependencies(probe);
        const controller = new DesktopRuntimeSmokeController(true, deps, { timeoutMs: 60_000 });
        controller.observe({ executeJavaScript: async () => ({ state: "ready", assetCount: "0" }) });
        await vi.waitFor(() => expect(deps.startSecondInstanceProbe).toHaveBeenCalledOnce());

        probe.complete(0);
        await Promise.resolve();
        expect(deps.requestQuit).not.toHaveBeenCalled();
        controller.secondInstanceObserved();
        expect(deps.requestQuit).toHaveBeenCalledWith(false);
        controller.dispose();
    });

    it.each([
        { label: "nonzero exit", exitCode: 7, expected: "second_instance_probe_exit=7" },
        { label: "signal exit", exitCode: null, expected: "second_instance_probe_exit=signal" },
    ])("fails when the competing process has a $label", async ({ exitCode, expected }) => {
        const probe = probeFixture();
        const deps = dependencies(probe);
        const controller = new DesktopRuntimeSmokeController(true, deps);
        controller.observe({ executeJavaScript: async () => ({ state: "ready", assetCount: "0" }) });
        await vi.waitFor(() => expect(deps.startSecondInstanceProbe).toHaveBeenCalledOnce());
        controller.secondInstanceObserved();
        probe.complete(exitCode);
        await vi.waitFor(() => expect(deps.requestQuit).toHaveBeenCalledWith(true));
        expect(deps.writeError).toHaveBeenCalledWith(`OAAM_DESKTOP_RUNTIME_SMOKE failed=${expected}\n`);
        expect(probe.terminate).toHaveBeenCalled();
    });

    it("fails when the competing process cannot be started", async () => {
        const deps = dependencies();
        deps.startSecondInstanceProbe.mockImplementation(() => {
            throw new Error("spawn failed");
        });
        const controller = new DesktopRuntimeSmokeController(true, deps);
        controller.observe({ executeJavaScript: async () => ({ state: "ready", assetCount: "0" }) });
        await vi.waitFor(() => expect(deps.requestQuit).toHaveBeenCalledWith(true));
        expect(deps.writeError).toHaveBeenCalledWith("OAAM_DESKTOP_RUNTIME_SMOKE failed=second_instance_probe_start_failed\n");
    });

    it("fails when no competing-process probe is configured", async () => {
        const deps = dependencies();
        const controller = new DesktopRuntimeSmokeController(true, {
            writeOutput: deps.writeOutput,
            writeError: deps.writeError,
            requestQuit: deps.requestQuit,
            proveOnboardingImport: deps.proveOnboardingImport,
        });
        controller.observe({ executeJavaScript: async () => ({ state: "ready", assetCount: "0" }) });
        await vi.waitFor(() => expect(deps.requestQuit).toHaveBeenCalledWith(true));
        expect(deps.writeError).toHaveBeenCalledWith("OAAM_DESKTOP_RUNTIME_SMOKE failed=second_instance_probe_unavailable\n");
    });

    it("fails before the competing-process proof when onboarding import cannot be proven", async () => {
        const deps = dependencies();
        const controller = new DesktopRuntimeSmokeController(true, {
            writeOutput: deps.writeOutput,
            writeError: deps.writeError,
            requestQuit: deps.requestQuit,
            startSecondInstanceProbe: deps.startSecondInstanceProbe,
        });
        controller.observe({ executeJavaScript: async () => ({ state: "ready", assetCount: "0" }) });
        await vi.waitFor(() => expect(deps.requestQuit).toHaveBeenCalledWith(true));
        expect(deps.writeError).toHaveBeenCalledWith("OAAM_DESKTOP_RUNTIME_SMOKE failed=onboarding_import_proof_unavailable\n");
        expect(deps.startSecondInstanceProbe).not.toHaveBeenCalled();
    });

    it("fails closed when the real onboarding import rejects", async () => {
        const deps = dependencies();
        deps.proveOnboardingImport.mockRejectedValueOnce(new Error("import failed"));
        const controller = new DesktopRuntimeSmokeController(true, deps);
        controller.observe({ executeJavaScript: async () => ({ state: "ready", assetCount: "0" }) });
        await vi.waitFor(() => expect(deps.requestQuit).toHaveBeenCalledWith(true));
        expect(deps.writeError).toHaveBeenCalledWith("OAAM_DESKTOP_RUNTIME_SMOKE failed=onboarding_import_failed\n");
        expect(deps.startSecondInstanceProbe).not.toHaveBeenCalled();
    });

    it("times out a renderer-owned onboarding import that never completes", async () => {
        const deps = dependencies();
        deps.proveOnboardingImport.mockImplementationOnce(() => new Promise(() => undefined));
        let timeout: (() => void) | undefined;
        const schedule = vi.fn((callback: () => void) => {
            timeout = callback;
            return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
        });
        const controller = new DesktopRuntimeSmokeController(true, { ...deps, schedule }, { timeoutMs: 60_000 });
        controller.observe({ executeJavaScript: async () => ({ state: "ready", assetCount: "0" }) });
        await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());

        timeout?.();

        expect(deps.writeError).toHaveBeenCalledWith("OAAM_DESKTOP_RUNTIME_SMOKE failed=timeout_onboarding_import\n");
        expect(deps.startSecondInstanceProbe).not.toHaveBeenCalled();
        expect(deps.requestQuit).toHaveBeenCalledWith(true);
    });

    it("fails when the competing-process probe rejects after starting", async () => {
        const probe = rejectingProbeFixture();
        const deps = {
            ...dependencies(),
            startSecondInstanceProbe: vi.fn(() => probe.probe),
        };
        const controller = new DesktopRuntimeSmokeController(true, deps);
        controller.observe({ executeJavaScript: async () => ({ state: "ready", assetCount: "0" }) });
        await vi.waitFor(() => expect(deps.startSecondInstanceProbe).toHaveBeenCalledOnce());
        probe.fail(new Error("probe transport failed"));
        await vi.waitFor(() => expect(deps.requestQuit).toHaveBeenCalledWith(true));
        expect(deps.writeError).toHaveBeenCalledWith("OAAM_DESKTOP_RUNTIME_SMOKE failed=second_instance_probe_failed\n");
    });

    it("terminates a competing process that never proves the single-instance event", async () => {
        const probe = probeFixture();
        const deps = dependencies(probe);
        let timeout: (() => void) | undefined;
        const schedule = vi.fn((callback: () => void) => {
            timeout = callback;
            return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
        });
        const controller = new DesktopRuntimeSmokeController(true, { ...deps, schedule }, { timeoutMs: 60_000 });
        controller.observe({ executeJavaScript: async () => ({ state: "ready", assetCount: "0" }) });
        await vi.waitFor(() => expect(deps.startSecondInstanceProbe).toHaveBeenCalledOnce());
        timeout?.();
        expect(deps.writeError).toHaveBeenCalledWith(
            "OAAM_DESKTOP_RUNTIME_SMOKE failed=timeout_second_instance_event=missing_probe=running\n",
        );
        expect(probe.terminate).toHaveBeenCalledOnce();
        expect(deps.requestQuit).toHaveBeenCalledWith(true);
    });

    it.each(["failed", "client_unavailable"])("fails immediately for renderer state %s", async (state) => {
        const deps = dependencies();
        const controller = new DesktopRuntimeSmokeController(true, deps);
        controller.observe({ executeJavaScript: async () => ({ state, assetCount: "" }) });
        await vi.waitFor(() => expect(deps.requestQuit).toHaveBeenCalledWith(true));
        expect(deps.writeError).toHaveBeenCalledWith(`OAAM_DESKTOP_RUNTIME_SMOKE failed=renderer=${state}\n`);
    });

    it("times out a rejected renderer probe instead of guessing readiness", async () => {
        vi.useFakeTimers();
        try {
            const deps = dependencies();
            const controller = new DesktopRuntimeSmokeController(true, deps, { pollIntervalMs: 1, timeoutMs: 0 });
            controller.observe({
                executeJavaScript: vi.fn().mockRejectedValueOnce(new Error("not ready")),
            });
            await vi.runAllTimersAsync();
            expect(deps.writeError).toHaveBeenCalledWith(
                "OAAM_DESKTOP_RUNTIME_SMOKE failed=timeout_renderer=unavailable_host=unobserved\n",
            );
            expect(deps.requestQuit).toHaveBeenCalledWith(true);
            controller.hostStopped();
            expect(deps.writeOutput).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("times out a non-empty ready projection instead of accepting the wrong catalog", async () => {
        vi.useFakeTimers();
        try {
            const deps = dependencies();
            const controller = new DesktopRuntimeSmokeController(true, deps, { pollIntervalMs: 1, timeoutMs: 0 });
            controller.observeHostState("starting");
            controller.observe({
                executeJavaScript: async () => ({ state: "ready", assetCount: "1" }),
            });
            await vi.runAllTimersAsync();
            expect(deps.writeError).toHaveBeenCalledWith(
                "OAAM_DESKTOP_RUNTIME_SMOKE failed=timeout_renderer=ready_host=starting\n",
            );
            expect(deps.requestQuit).toHaveBeenCalledWith(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects a second observed window in one packaged smoke run", () => {
        const deps = dependencies();
        const controller = new DesktopRuntimeSmokeController(true, deps);
        controller.observe({ executeJavaScript: async () => new Promise(() => undefined) });
        expect(() => controller.observe({ executeJavaScript: async () => null })).toThrow(/only one packaged window/u);
        controller.dispose();
    });
});
