import type { ProductionHostLaunchOptions } from "@oaam/app-server-bootstrap";
import { describe, expect, it, vi } from "vitest";
import { UtilityHostSupervisor, type UtilityProcessHandle, type UtilityTransferPort } from "../src/main/utility-host-supervisor";

class FakeProcess implements UtilityProcessHandle {
    readonly messages: Array<{ readonly message: unknown; readonly transfer: readonly UtilityTransferPort[] }> = [];
    readonly messageListeners: Array<(message: unknown) => void> = [];
    readonly exitListeners: Array<(code: number) => void> = [];
    throwOnPost = false;

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
        return true;
    }

    public emitMessage(message: unknown): void {
        for (const listener of this.messageListeners) listener(message);
    }

    public emitExit(code: number): void {
        for (const listener of this.exitListeners) listener(code);
    }
}

const OPTIONS: ProductionHostLaunchOptions = {
    oaamRoot: "/state",
    platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
};

describe("Desktop utility Host observed Project root", () => {
    it("resolves registration and file-manager reveal through the exact renderer connection", async () => {
        const child = new FakeProcess();
        const controlIds = ["connection-1", "registration-1", "reveal-1", "denied-1"];
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => child,
                createChannel: () => ({ hostPort: { close: vi.fn() }, clientPort: { close: vi.fn() } }),
                createControlId: () => controlIds.shift() ?? "unexpected-id",
            },
            OPTIONS,
        );
        const reference = {
            probeToken: "probe-token",
            probeResultRowId: "probe-result-row",
            projectRowId: "project-row",
            sourceRootRowId: "source-root-row",
        };

        await expect(supervisor.resolveObservedProjectRoot("registration", reference)).rejects.toThrow(/unavailable/u);
        supervisor.start();
        child.emitMessage({ type: "ready", hostInstanceId: "host-1", startupDisposition: { mode: "normal" } });
        supervisor.connect();

        const registration = supervisor.resolveObservedProjectRoot("registration", reference);
        expect(child.messages.at(-1)?.message).toEqual({
            type: "resolve_observed_project_root",
            requestId: "registration-1",
            connectionKey: "connection-1",
            purpose: "registration",
            reference,
        });
        child.emitMessage({
            type: "observed_project_root_resolved",
            requestId: "registration-1",
            purpose: "registration",
            rootPath: "/project",
            localPathSelectionToken: "project-root-token",
        });
        await expect(registration).resolves.toEqual({
            purpose: "registration",
            rootPath: "/project",
            localPathSelectionToken: "project-root-token",
        });

        const reveal = supervisor.resolveObservedProjectRoot("reveal", reference);
        child.emitMessage({
            type: "observed_project_root_resolved",
            requestId: "reveal-1",
            purpose: "reveal",
            rootPath: "/project",
        });
        await expect(reveal).resolves.toEqual({ purpose: "reveal", rootPath: "/project" });

        const denied = supervisor.resolveObservedProjectRoot("reveal", reference);
        child.emitMessage({
            type: "observed_project_root_resolution_failed",
            requestId: "denied-1",
            code: "host.observed_project_root_unavailable",
        });
        await expect(denied).rejects.toThrow("host.observed_project_root_unavailable");

        child.throwOnPost = true;
        await expect(supervisor.resolveObservedProjectRoot("reveal", reference)).rejects.toThrow(/could not be delivered/u);
        child.throwOnPost = false;
        const interrupted = supervisor.resolveObservedProjectRoot("reveal", reference);
        child.emitExit(7);
        await expect(interrupted).rejects.toThrow(/exited before observed Project root resolution/u);
    });
});
