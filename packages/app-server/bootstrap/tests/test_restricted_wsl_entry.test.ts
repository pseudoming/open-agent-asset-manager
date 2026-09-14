import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RestrictedServiceComposition } from "../../host/src/restricted-service-process";
import {
    RESTRICTED_PROBE_PROTOCOL,
    RESTRICTED_PROBE_MAX_FRAME_BYTES,
    RESTRICTED_SOURCE_PROTOCOL,
    RESTRICTED_SOURCE_MAX_FRAME_BYTES,
    RESTRICTED_TARGET_PROTOCOL,
    RESTRICTED_TARGET_MAX_FRAME_BYTES,
} from "@oaam/core/restricted-operations";
import { BUILTIN_PROVIDERS, createBuiltinProvidersForRestrictedProbe } from "../src/builtin-providers";

const seam = vi.hoisted(() => ({
    run: vi.fn<(compose: (configuration: unknown) => Promise<RestrictedServiceComposition>) => Promise<void>>(
        async () => undefined,
    ),
}));
// Capture only the physical process entry. The Bootstrap callback below constructs
// the original Core services and actual six-Provider inventory without running consumers.
vi.mock("@oaam/app-server-host/restricted-transport", () => ({ runRestrictedServiceProcess: seam.run }));
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function composition(value: unknown) {
    await import("../src/restricted-wsl-entry");
    expect(seam.run).toHaveBeenCalledOnce();
    return seam.run.mock.calls[0]![0](value);
}

describe("original restricted Bootstrap composition", () => {
    it.each([
        null,
        1,
        [],
        {},
        { configuration: {}, protocol: "unknown", extra: true },
    ])("rejects malformed entry %j", async (value) => {
        await expect(composition(value)).rejects.toThrow("invalid restricted Bootstrap operation");
    });
    it("rejects an unknown protocol without constructing a different service", async () => {
        await expect(composition({ protocol: "unknown", configuration: {} })).rejects.toThrow(
            "unknown restricted Bootstrap operation",
        );
    });
    it.each([
        RESTRICTED_PROBE_PROTOCOL,
        RESTRICTED_SOURCE_PROTOCOL,
        RESTRICTED_TARGET_PROTOCOL,
    ])("constructs the original %s service with exact session and bounds", async (protocol) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-bootstrap-entry-control-"));
        roots.push(root);
        const platformContext = {
            platform: "wsl" as const,
            platformInstanceId: "Ubuntu",
            accessRootPath: `\\\\wsl.localhost\\Ubuntu${root.replaceAll("/", "\\")}`,
        };
        const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() },
            deadlineAt = Date.now() + 60_000;
        const configuration =
            protocol === RESTRICTED_TARGET_PROTOCOL
                ? {
                      ...session,
                      deadlineAt,
                      bindings: [
                          {
                              bindingId: randomUUID(),
                              deploymentId: randomUUID(),
                              platformInstanceId: "Ubuntu",
                              targetRootPath: platformContext.accessRootPath,
                              executionRootPath: root,
                          },
                      ],
                  }
                : {
                      ...session,
                      deadlineAt,
                      platformContext,
                      ...(protocol === RESTRICTED_SOURCE_PROTOCOL ? { maximumResultBytes: 16_384 } : {}),
                  };
        const result = await composition({ protocol, configuration });
        try {
            expect(result.session).toEqual({ ...session, protocol });
            expect(result.deadlineAt).toBe(deadlineAt);
            expect(result.maximumFrameBytes).toBe(
                protocol === RESTRICTED_PROBE_PROTOCOL
                    ? RESTRICTED_PROBE_MAX_FRAME_BYTES
                    : protocol === RESTRICTED_SOURCE_PROTOCOL
                      ? RESTRICTED_SOURCE_MAX_FRAME_BYTES
                      : RESTRICTED_TARGET_MAX_FRAME_BYTES,
            );
            expect(result.maximumConcurrentRequests).toBe(
                protocol === RESTRICTED_PROBE_PROTOCOL ? 16 : protocol === RESTRICTED_SOURCE_PROTOCOL ? 1 : undefined,
            );
            expect(typeof result.service.handle).toBe("function");
            expect(fs.readdirSync(root)).toEqual([]);
        } finally {
            result.service.close?.();
        }
    });
    it("retains all six Providers and changes only Codex's private Host-coordinate binding", () => {
        const providers = createBuiltinProvidersForRestrictedProbe({
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            accessRootPath: "\\\\wsl.localhost\\Ubuntu\\owned",
        });
        expect(providers.map((provider) => provider.adapterId)).toEqual(BUILTIN_PROVIDERS.map((provider) => provider.adapterId));
        expect(providers).toHaveLength(6);
        for (let index = 0; index < providers.length; index += 1) {
            if (BUILTIN_PROVIDERS[index]!.adapterId === "CODEX") expect(providers[index]).not.toBe(BUILTIN_PROVIDERS[index]);
            else expect(providers[index]).toBe(BUILTIN_PROVIDERS[index]);
        }
        expect(Object.isFrozen(providers)).toBe(true);
    });
});
