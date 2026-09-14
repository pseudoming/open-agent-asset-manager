/** Desktop target selection through the real Protocol, Production Host, and Core enablement authority. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProtocolRequestV1 } from "@oaam/app-server-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchProductionHost } from "../../../app-server/bootstrap/src/production-bootstrap";
import type { ProductionHost } from "../../../app-server/host/src";
import { clearRegistry } from "../../../core/src/orchestration/adapter-registry";
import { closeDb } from "../../../core/src/persistence/db";
import { createClientConnection, type ClientMessageTransport } from "../../framework/src";
import { DesktopApplicationClient } from "../src/renderer/client/desktop-application-client";
import { DiscoveryController } from "../src/renderer/features/discovery/discovery-controller";

class ProductionLoopbackTransport implements ClientMessageTransport {
    readonly #messageListeners = new Set<(message: unknown) => void>();
    readonly #closeListeners = new Set<(reason: unknown) => void>();
    #serverReceiver: ((message: unknown) => void) | undefined;

    public attachServer(receiver: (message: unknown) => void): void {
        this.#serverReceiver = receiver;
    }

    public send(message: ProtocolRequestV1): void {
        const receiver = this.#serverReceiver;
        if (receiver === undefined) throw new Error("production loopback Host is not attached");
        queueMicrotask(() => receiver(message));
    }

    public subscribeMessage(listener: (message: unknown) => void): () => void {
        this.#messageListeners.add(listener);
        return () => this.#messageListeners.delete(listener);
    }

    public subscribeClose(listener: (reason: unknown) => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    public close(): void {}

    public deliverFromHost(message: unknown): void {
        queueMicrotask(() => {
            for (const listener of this.#messageListeners) listener(message);
        });
    }

    public closeFromHost(reason: unknown): void {
        queueMicrotask(() => {
            for (const listener of this.#closeListeners) listener(reason);
        });
    }
}

describe("Desktop target enablement production conformance", () => {
    let root = "";
    let productionHost: ProductionHost | null = null;
    let savedEnvironment: Record<"HOME" | "PATH", string | undefined>;

    beforeEach(() => {
        savedEnvironment = { HOME: process.env.HOME, PATH: process.env.PATH };
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-desktop-target-enablement-"));
        process.env.HOME = path.join(root, "home");
        process.env.PATH = path.join(root, "bin");
        fs.mkdirSync(process.env.HOME, { recursive: true });
        fs.mkdirSync(process.env.PATH, { recursive: true });
        clearRegistry();
        closeDb();
    });

    afterEach(async () => {
        await productionHost?.shutdown();
        productionHost = null;
        restoreEnvironment(savedEnvironment);
        closeDb();
        clearRegistry();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("commits each selected Provider before probing and carries one exact installation folder end to end", async () => {
        const projectRoot = path.join(root, "project");
        const installationRoot = path.join(root, "cursor-installation");
        fs.mkdirSync(projectRoot, { recursive: true });
        fs.mkdirSync(installationRoot, { recursive: true });
        fs.writeFileSync(path.join(installationRoot, "cursor-agent"), "Cursor Agent fixture");
        productionHost = launchProductionHost({
            oaamRoot: path.join(root, "oaam"),
            databasePath: path.join(root, "state.db"),
            platformContexts: [{ platform: "linux", platformInstanceId: "fixture", accessRootPath: root }],
        });
        const transport = new ProductionLoopbackTransport();
        const requestedOperations: string[] = [];
        const hostConnection = productionHost.openConnection({
            send: (message) => transport.deliverFromHost(message),
            close: (reason) => transport.closeFromHost(reason),
        });
        transport.attachServer((message) => {
            if (typeof message === "object" && message !== null && "method" in message) {
                const method = (message as { readonly method?: unknown }).method;
                if (typeof method === "string") requestedOperations.push(method);
            }
            hostConnection.receive(message);
        });
        let requestSequence = 0;
        const connection = createClientConnection(transport, {
            createRequestId: () => `desktop-target-${++requestSequence}`,
            reportListenerError: (error) => {
                throw error;
            },
        });
        await connection.initialize({ protocolVersion: 1, clientKind: "desktop", clientVersion: "0.1.0" });
        const client = new DesktopApplicationClient(connection);
        const registrationToken = hostConnection.registerLocalPathSelection("project_root", projectRoot);
        const registered = await client.registerProject({
            localPathSelectionToken: registrationToken,
            displayName: "Target enablement fixture",
        });
        if (registered.status !== "complete") throw new Error("fixture Project registration failed");
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "desktop-target-enable-action",
            autoProbeWatched: false,
            purpose: "target_discovery",
            targetProjectId: registered.value.projectId,
        });
        await controller.load();
        if (controller.state.status !== "ready") throw new Error("target discovery did not load");
        for (const provider of controller.state.providers) {
            if (provider.adapterId !== "ZCODE" && controller.state.selectedAdapterIds.includes(provider.adapterId)) {
                controller.toggleProvider(provider.adapterId);
            }
        }
        expect(controller.targetProbeAuthorizationRequired()).toBe(true);
        await expect(controller.authorizeSelectedProvidersForTargetProbe()).resolves.toBe(true);
        expect(controller.targetProbeAuthorizationRequired()).toBe(false);
        const probeToken = hostConnection.registerLocalPathSelection("project_root", projectRoot);
        await controller.probeProject(probeToken);

        const enablement = await client.getAdapterEnablement();
        expect(enablement.status).toBe("complete");
        if (enablement.status !== "complete") throw new Error("enablement read failed");
        expect(enablement.value.enabledAdapterIds).toEqual(["ZCODE"]);
        expect(controller.state, JSON.stringify(controller.state)).toMatchObject({
            status: "ready",
            activity: "idle",
            selectedAdapterIds: ["ZCODE"],
            probeReview: { results: [expect.objectContaining({ adapterId: "ZCODE" })] },
        });
        if (controller.state.status !== "ready" || controller.state.probeReview === undefined) {
            throw new Error("target probe receipt is missing");
        }
        expect(
            controller.state.probeReview.results.flatMap((result) => [
                ...result.diagnostics,
                ...result.runtimes.flatMap((runtime) => runtime.diagnostics),
            ]),
        ).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "settings.adapter_disabled" })]));
        expect(requestedOperations.indexOf("adapter_enablement.replace")).toBeGreaterThan(-1);
        expect(requestedOperations.indexOf("adapter_enablement.replace")).toBeLessThan(
            requestedOperations.indexOf("adapter.probe"),
        );

        controller.dispose();
        const manualProbeOperationOffset = requestedOperations.length;
        const manualController = new DiscoveryController(client, {
            createUserActionId: () => "desktop-installation-root-action",
            autoProbeWatched: false,
            purpose: "target_discovery",
            targetProjectId: registered.value.projectId,
        });
        await manualController.load();
        if (manualController.state.status !== "ready") throw new Error("manual target discovery did not load");
        for (const provider of manualController.state.providers) {
            const selected = manualController.state.selectedAdapterIds.includes(provider.adapterId);
            if ((provider.adapterId === "CURSOR") !== selected) manualController.toggleProvider(provider.adapterId);
        }
        expect(manualController.targetProbeAuthorizationRequired()).toBe(true);
        await expect(manualController.authorizeSelectedProvidersForTargetProbe()).resolves.toBe(true);
        expect(manualController.targetProbeAuthorizationRequired()).toBe(false);
        const projectProbeToken = hostConnection.registerLocalPathSelection("project_root", projectRoot);
        const installationToken = hostConnection.registerLocalPathSelection("installation_root", installationRoot);

        await expect(
            manualController.probeInstallationRoot(
                "CURSOR",
                { platform: "linux", platformInstanceId: "fixture" },
                installationToken,
                projectProbeToken,
            ),
        ).resolves.toBe(true);

        expect(manualController.state).toMatchObject({
            status: "ready",
            activity: "idle",
            selectedAdapterIds: ["CURSOR"],
            probeReview: {
                results: [
                    expect.objectContaining({
                        adapterId: "CURSOR",
                        environment: { platform: "linux", platformInstanceId: "fixture" },
                        runtimes: expect.arrayContaining([
                            expect.objectContaining({
                                agentRuntimeId: "CURSOR_AGENT_CLI",
                                installationStatus: "available",
                            }),
                        ]),
                    }),
                ],
            },
        });
        const manualProbeOperations = requestedOperations.slice(manualProbeOperationOffset);
        expect(manualProbeOperations.filter((operation) => operation === "adapter.probe")).toHaveLength(1);
        expect(manualProbeOperations.indexOf("adapter_enablement.replace")).toBeLessThan(
            manualProbeOperations.indexOf("adapter.probe"),
        );

        manualController.dispose();
        connection.close();
        hostConnection.close();
    });
});

function restoreEnvironment(saved: Record<"HOME" | "PATH", string | undefined>): void {
    for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
}
