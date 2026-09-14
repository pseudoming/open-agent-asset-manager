import type { HostStateResilienceIntegration, ProductionHost } from "@oaam/app-server-host";
import type { CoreServiceConfiguration } from "@oaam/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({
    configuration: undefined as CoreServiceConfiguration | undefined,
    stateResilience: undefined as HostStateResilienceIntegration | undefined,
}));

vi.mock("@oaam/app-server-host", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@oaam/app-server-host")>();
    return {
        ...actual,
        createProductionHost: vi.fn((_core, stateResilience: HostStateResilienceIntegration): ProductionHost => {
            capture.stateResilience = stateResilience;
            return {
                hostInstanceId: "host-defaults",
                state: "ready",
                availableOperations: [],
                openConnection: vi.fn(),
                resolveStateBackupFileAction: vi.fn(),
                beginExclusiveRestore: vi.fn(),
                drain: vi.fn(),
                shutdown: vi.fn(),
            } as unknown as ProductionHost;
        }),
    };
});

vi.mock("@oaam/core", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@oaam/core")>();
    return {
        ...actual,
        createCoreService: vi.fn((configuration: CoreServiceConfiguration) => {
            capture.configuration = configuration;
            return {};
        }),
        createStateRestoreService: vi.fn((options: { readonly quiesceMutations: () => Promise<void> }) => ({
            inspectStateRestore: vi.fn(async () => {
                await options.quiesceMutations();
            }),
            activateStateRestore: vi.fn(async () => undefined),
        })),
        reconcileStateRestoreBeforeStartup: vi.fn(),
    };
});

import { launchProductionHost } from "../src";

describe("production bootstrap State resilience defaults", () => {
    beforeEach(() => {
        capture.configuration = undefined;
        capture.stateResilience = undefined;
    });

    it("keeps Headless preference ownership absent and provides a finite replacement no-op", async () => {
        expect(
            launchProductionHost({
                oaamRoot: "/profile",
                platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
            }),
        ).toMatchObject({ state: "ready" });
        const integration = capture.stateResilience;
        if (integration === undefined) throw new TypeError("State resilience integration was not captured");

        await expect(integration.readDesktopPreferences()).resolves.toBeUndefined();
        await expect(integration.inspectStateRestore({ archivePath: "/backup.zip" })).resolves.toBeUndefined();
        await expect(integration.applyRestoredDesktopPreferences(new Uint8Array(), "/profile.restore")).rejects.toThrow(
            /no Desktop preference owner/u,
        );
        expect(() => integration.restoreRequiresHostReplacement()).not.toThrow();
        const configuration = capture.configuration;
        if (configuration === undefined) throw new TypeError("Core configuration was not captured");
        expect(configuration.confirmOneTimeRenderApproval?.({} as never)).toBeNull();
    });
});
