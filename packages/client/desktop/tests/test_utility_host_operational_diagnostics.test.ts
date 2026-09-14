import type { ProductionHostLaunchOptions } from "@oaam/app-server-bootstrap";
import { describe, expect, it } from "vitest";
import { UtilityHostSupervisor, type UtilityProcessHandle, type UtilityTransferPort } from "../src/main/utility-host-supervisor";

class DiagnosticProcess implements UtilityProcessHandle {
    readonly messages: Array<{ readonly message: unknown; readonly transfer: readonly UtilityTransferPort[] }> = [];
    readonly #messageListeners: Array<(message: unknown) => void> = [];
    throwOnPost = false;

    public onMessage(listener: (message: unknown) => void): () => void {
        this.#messageListeners.push(listener);
        return () => undefined;
    }

    public onExit(_listener: (code: number) => void): () => void {
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
        for (const listener of this.#messageListeners) listener(message);
    }
}

const options: ProductionHostLaunchOptions = {
    oaamRoot: "/state",
    platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
};

function createSupervisor(process: DiagnosticProcess): UtilityHostSupervisor {
    return new UtilityHostSupervisor(
        {
            spawn: () => process,
            createChannel: () => ({
                hostPort: { close() {} },
                clientPort: { close() {} },
            }),
        },
        options,
    );
}

describe("Desktop utility Host operational diagnostics", () => {
    it("forwards queued finite lifecycle codes after readiness without owning supervisor health", () => {
        const process = new DiagnosticProcess();
        const supervisor = createSupervisor(process);
        supervisor.start();
        expect(process.messages).toEqual([{ message: { type: "boot", options }, transfer: [] }]);
        process.emitMessage({
            type: "ready",
            hostInstanceId: "host",
            startupDisposition: { mode: "normal" },
        });
        expect(process.messages.slice(1).map(({ message }) => message)).toEqual([
            { type: "record_operational_diagnostic", code: "desktop.host.starting" },
            { type: "record_operational_diagnostic", code: "desktop.host.ready" },
        ]);
        supervisor.drain();
        expect(process.messages.slice(-2).map(({ message }) => message)).toEqual([
            { type: "record_operational_diagnostic", code: "desktop.host.draining" },
            { type: "drain" },
        ]);
    });

    it("does not change supervisor state when diagnostic delivery fails", () => {
        const process = new DiagnosticProcess();
        const supervisor = createSupervisor(process);
        supervisor.start();
        process.throwOnPost = true;
        process.emitMessage({
            type: "ready",
            hostInstanceId: "host-with-unavailable-diagnostics",
            startupDisposition: { mode: "normal" },
        });
        expect(supervisor.state).toBe("ready");
    });

    it("queues and forwards one exact privacy-bounded Renderer receipt", () => {
        const process = new DiagnosticProcess();
        const supervisor = createSupervisor(process);
        supervisor.recordRendererDiagnostic({
            event: "failure",
            failureKind: "render",
            surface: "library",
            componentTrail: ["AssetVersionPanel"],
        });
        supervisor.start();
        process.emitMessage({
            type: "ready",
            hostInstanceId: "host",
            startupDisposition: { mode: "normal" },
        });
        expect(process.messages.map(({ message }) => message)).toContainEqual({
            type: "record_operational_diagnostic",
            code: "desktop.renderer.event",
            event: "failure",
            failureKind: "render",
            surface: "library",
            componentTrail: ["AssetVersionPanel"],
        });
    });
});
