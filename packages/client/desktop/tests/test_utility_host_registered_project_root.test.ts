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
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("Desktop utility Host registered Project root", () => {
    it("resolves probing and file-manager reveal through the exact renderer connection", async () => {
        const child = new FakeProcess();
        const controlIds = ["connection-1", "probe-1", "reveal-1", "denied-1"];
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => child,
                createChannel: () => ({ hostPort: { close: vi.fn() }, clientPort: { close: vi.fn() } }),
                createControlId: () => controlIds.shift() ?? "unexpected-id",
            },
            OPTIONS,
        );

        await expect(supervisor.resolveRegisteredProjectRoot("probe", PROJECT_ID)).rejects.toThrow(/unavailable/u);
        supervisor.start();
        child.emitMessage({ type: "ready", hostInstanceId: "host-1", startupDisposition: { mode: "normal" } });
        supervisor.connect();

        const probe = supervisor.resolveRegisteredProjectRoot("probe", PROJECT_ID);
        expect(child.messages.at(-1)?.message).toEqual({
            type: "resolve_registered_project_root",
            requestId: "probe-1",
            connectionKey: "connection-1",
            purpose: "probe",
            projectId: PROJECT_ID,
        });
        child.emitMessage({
            type: "registered_project_root_resolved",
            requestId: "probe-1",
            purpose: "probe",
            rootPath: "/project",
            localPathSelectionToken: "project-root-token",
        });
        await expect(probe).resolves.toEqual({
            purpose: "probe",
            rootPath: "/project",
            localPathSelectionToken: "project-root-token",
        });

        const reveal = supervisor.resolveRegisteredProjectRoot("reveal", PROJECT_ID);
        child.emitMessage({
            type: "registered_project_root_resolved",
            requestId: "reveal-1",
            purpose: "reveal",
            rootPath: "/project",
        });
        await expect(reveal).resolves.toEqual({ purpose: "reveal", rootPath: "/project" });

        const denied = supervisor.resolveRegisteredProjectRoot("reveal", PROJECT_ID);
        child.emitMessage({
            type: "registered_project_root_resolution_failed",
            requestId: "denied-1",
            code: "host.registered_project_root_unavailable",
        });
        await expect(denied).rejects.toThrow("host.registered_project_root_unavailable");

        child.throwOnPost = true;
        await expect(supervisor.resolveRegisteredProjectRoot("reveal", PROJECT_ID)).rejects.toThrow(/could not be delivered/u);
        child.throwOnPost = false;
        const interrupted = supervisor.resolveRegisteredProjectRoot("reveal", PROJECT_ID);
        child.emitExit(7);
        await expect(interrupted).rejects.toThrow(/exited before registered Project root resolution/u);
    });
});
