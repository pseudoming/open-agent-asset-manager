import { describe, expect, it, vi } from "vitest";
import { DiscoveryController } from "../src/renderer/features/discovery/discovery-controller";
import { localizedText } from "../src/renderer/presentation";
import { DIGEST, diagnostic, ENABLEMENT, ENVIRONMENT, fakeDiscoveryClient, PROBE, required } from "./discovery-test-fixtures";

describe("Desktop target-discovery enablement", () => {
    it("keeps local checking byte-read-only and authorizes disabled Providers through a separate action", async () => {
        const probeProject = vi.fn(async () => ({ status: "complete" as const, value: PROBE, diagnostics: [] }));
        const client = fakeDiscoveryClient({ probeProject });
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "target-action",
            autoProbeWatched: false,
            purpose: "target_discovery",
        });

        await controller.load();
        expect(controller.state).toMatchObject({
            status: "ready",
            selectedAdapterIds: ["CLAUDECODE", "OPENCODE"],
            enablement: { enabledAdapterIds: ["CLAUDECODE"] },
        });
        controller.toggleProvider("CLAUDECODE");
        await controller.probeProject("project-root-token");

        expect(client.replaceAdapterEnablement).not.toHaveBeenCalled();
        expect(probeProject).not.toHaveBeenCalled();
        await expect(controller.authorizeSelectedProvidersForTargetProbe()).resolves.toBe(true);

        expect(client.replaceAdapterEnablement).toHaveBeenCalledWith({
            expectedRevision: 1,
            expectedSettingFingerprint: DIGEST,
            enabledAdapterIds: ["CLAUDECODE", "OPENCODE"],
            userActionId: "target-action",
        });
        expect(probeProject).not.toHaveBeenCalled();
        await controller.probeProject("project-root-token");
        expect(probeProject).toHaveBeenCalledWith(
            ["OPENCODE"],
            [ENVIRONMENT],
            "project-root-token",
            undefined,
            expect.any(Function),
        );
        expect(
            required(
                vi.mocked(client.replaceAdapterEnablement).mock.invocationCallOrder[0],
                "target enablement invocation order",
            ),
        ).toBeLessThan(required(probeProject.mock.invocationCallOrder[0], "target probe invocation order"));
        expect(controller.state).toMatchObject({
            status: "ready",
            selectedAdapterIds: ["OPENCODE"],
            enablement: { enabledAdapterIds: ["CLAUDECODE", "OPENCODE"] },
        });
        controller.dispose();

        const staleClient = fakeDiscoveryClient({
            replaceAdapterEnablement: vi.fn(async () => ({
                status: "failed",
                diagnostics: [diagnostic("The tool setting changed in another window.")],
            })),
        });
        const stale = new DiscoveryController(staleClient, {
            createUserActionId: () => "stale-target-action",
            autoProbeWatched: false,
            purpose: "target_discovery",
        });
        await stale.load();
        await stale.authorizeSelectedProvidersForTargetProbe();
        expect(staleClient.probeProject).not.toHaveBeenCalled();
        expect(stale.state).toMatchObject({
            status: "ready",
            activity: "save_failed",
            message: localizedText("discovery.provider.save_failed"),
        });
        stale.dispose();
    });

    it("dispatches zero target probes when the enablement authority throws before returning a receipt", async () => {
        const client = fakeDiscoveryClient({
            replaceAdapterEnablement: vi.fn(async () => {
                throw new Error("settings transport closed");
            }),
        });
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "failed-target-action",
            autoProbeWatched: false,
            purpose: "target_discovery",
        });

        await controller.load();
        await controller.authorizeSelectedProvidersForTargetProbe();

        expect(client.probeProject).not.toHaveBeenCalled();
        expect(controller.state).toMatchObject({
            status: "ready",
            activity: "save_failed",
            message: localizedText("discovery.provider.save_failed"),
            activityDiagnostics: [],
        });
        controller.dispose();
    });

    it("rejects a complete receipt that omits one selected Provider", async () => {
        const client = fakeDiscoveryClient({
            replaceAdapterEnablement: vi.fn(async () => ({ status: "complete", value: ENABLEMENT, diagnostics: [] })),
        });
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "incomplete-target-action",
            autoProbeWatched: false,
            purpose: "target_discovery",
        });

        await controller.load();
        await controller.authorizeSelectedProvidersForTargetProbe();

        expect(client.probeProject).not.toHaveBeenCalled();
        expect(controller.state).toMatchObject({ status: "ready", activity: "save_failed" });
        controller.dispose();
    });

    it("rechecks one exact Provider and environment through the one-shot installation-root authority", async () => {
        const manualProbe = structuredClone(PROBE);
        const manualResult = required(manualProbe.results[0], "manual installation-root probe result");
        const manualRuntime = required(manualResult.runtimes[0], "manual installation-root runtime result");
        manualResult.adapterId = "OPENCODE";
        manualRuntime.agentRuntimeId = "OPENCODE_CLI";
        const probeGlobal = vi.fn(async () => ({ status: "complete" as const, value: manualProbe, diagnostics: [] }));
        const client = fakeDiscoveryClient({ probeGlobal });
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "manual-location-action",
            autoProbeWatched: false,
            purpose: "target_discovery",
        });

        await controller.load();
        await expect(controller.authorizeSelectedProvidersForTargetProbe()).resolves.toBe(true);
        await expect(controller.probeInstallationRoot("OPENCODE", ENVIRONMENT, "installation-token")).resolves.toBe(true);
        expect(client.replaceAdapterEnablement).toHaveBeenCalledWith(
            expect.objectContaining({ enabledAdapterIds: ["CLAUDECODE", "OPENCODE"] }),
        );
        expect(probeGlobal).toHaveBeenCalledWith(["OPENCODE"], [ENVIRONMENT], "installation-token", expect.any(Function));
        expect(client.probeProject).not.toHaveBeenCalled();
        expect(controller.state).toMatchObject({
            status: "ready",
            selectedAdapterIds: ["OPENCODE"],
            selectedEnvironmentKeys: ["linux\0local"],
        });
        controller.dispose();
    });

    it("sends no installation-root probe for malformed, mismatched, or non-target requests", async () => {
        const targetClient = fakeDiscoveryClient();
        const target = new DiscoveryController(targetClient, {
            createUserActionId: () => "manual-location-reject",
            autoProbeWatched: false,
            purpose: "target_discovery",
            targetProjectId: "project-id",
        });
        await target.load();
        await expect(target.probeInstallationRoot("UNKNOWN", ENVIRONMENT, "token", "project-token")).resolves.toBe(false);
        await expect(target.probeInstallationRoot("CLAUDECODE", ENVIRONMENT, " ", "project-token")).resolves.toBe(false);
        await expect(target.probeInstallationRoot("CLAUDECODE", ENVIRONMENT, "token")).resolves.toBe(false);
        expect(targetClient.probeProject).not.toHaveBeenCalled();
        target.dispose();

        const sourceClient = fakeDiscoveryClient();
        const source = new DiscoveryController(sourceClient, {
            createUserActionId: () => "source-request",
            autoProbeWatched: false,
            purpose: "source_discovery",
        });
        await source.load();
        await expect(source.probeInstallationRoot("CLAUDECODE", ENVIRONMENT, "token")).resolves.toBe(false);
        expect(sourceClient.probeGlobal).not.toHaveBeenCalled();
        source.dispose();
    });
});
