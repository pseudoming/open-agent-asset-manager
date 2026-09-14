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

describe("Desktop utility Host import-preview file resolution", () => {
    it("resolves only through the exact renderer connection and rejects failures or interruption", async () => {
        const child = new FakeProcess();
        const controlIds = ["connection-1", "file-1", "file-denied", "file-post", "file-interrupted"];
        const supervisor = new UtilityHostSupervisor(
            {
                spawn: () => child,
                createChannel: () => ({ hostPort: { close: vi.fn() }, clientPort: { close: vi.fn() } }),
                createControlId: () => controlIds.shift() ?? "unexpected-id",
            },
            OPTIONS,
        );
        const reference = {
            previewToken: "preview-token",
            candidateId: "candidate-id",
            logicalPath: "nested/SKILL.md",
        };

        await expect(supervisor.resolveImportPreviewFileDirectory(reference)).rejects.toThrow(/unavailable/u);
        supervisor.start();
        child.emitMessage({ type: "ready", hostInstanceId: "host-1", startupDisposition: { mode: "normal" } });
        supervisor.connect();

        const resolved = supervisor.resolveImportPreviewFileDirectory(reference);
        expect(child.messages.at(-1)?.message).toEqual({
            type: "resolve_import_preview_file_directory",
            requestId: "file-1",
            connectionKey: "connection-1",
            reference,
        });
        child.emitMessage({
            type: "import_preview_file_directory_resolved",
            requestId: "file-1",
            directoryPath: "/source/skill/nested",
        });
        await expect(resolved).resolves.toBe("/source/skill/nested");

        const denied = supervisor.resolveImportPreviewFileDirectory(reference);
        child.emitMessage({
            type: "import_preview_file_directory_resolution_failed",
            requestId: "file-denied",
            code: "host.import_preview_file_unavailable",
        });
        await expect(denied).rejects.toThrow("host.import_preview_file_unavailable");

        child.throwOnPost = true;
        await expect(supervisor.resolveImportPreviewFileDirectory(reference)).rejects.toThrow(/could not be delivered/u);
        child.throwOnPost = false;
        const interrupted = supervisor.resolveImportPreviewFileDirectory(reference);
        child.emitExit(7);
        await expect(interrupted).rejects.toThrow(/exited before import-preview file resolution/u);
    });
});
