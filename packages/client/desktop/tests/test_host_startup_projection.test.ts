import type { DesktopOperationalDiagnosticCode } from "@oaam/app-server-protocol";
import { describe, expect, it, vi } from "vitest";
import { projectDesktopHostStartup, recoverDesktopSession } from "../src/main/host-startup-projection";
import type { UtilityHostSupervisorEvent } from "../src/main/utility-host-supervisor";

function event(
    state: UtilityHostSupervisorEvent["state"],
    reasonCode: "" | DesktopOperationalDiagnosticCode = "",
): UtilityHostSupervisorEvent {
    return state === "ready"
        ? {
              state,
              hostInstanceId: "host-1",
              reasonCode,
              startupDisposition: { mode: "normal" },
          }
        : { state, hostInstanceId: "", reasonCode };
}

describe("Desktop Host startup projection", () => {
    it("preserves exact starting, recovery, ready and failed lifecycle facts", () => {
        expect(projectDesktopHostStartup(event("starting"))).toEqual({ status: "starting" });
        expect(projectDesktopHostStartup(event("starting", "host.startup_recovering"))).toEqual({
            status: "recovering",
            reasonCode: "host.startup_recovering",
        });
        expect(projectDesktopHostStartup(event("ready"))).toEqual({ status: "ready" });
        expect(
            projectDesktopHostStartup({
                ...event("ready"),
                startupDisposition: { mode: "state_recovery", reason: "restore_reconciliation" },
            }),
        ).toEqual({ status: "ready", recoveryReason: "restore_reconciliation" });
        expect(projectDesktopHostStartup(event("failed", "host.process_failed"))).toEqual({
            status: "failed",
            reasonCode: "host.process_failed",
        });
        expect(projectDesktopHostStartup(event("failed"))).toEqual({
            status: "failed",
            reasonCode: "desktop.host.failed",
        });
        expect(projectDesktopHostStartup(event("stopped"))).toBeUndefined();
    });

    it("reconnects a healthy Host, retries a failed Host, and rejects an in-progress cycle", () => {
        const reconnectRenderer = vi.fn();
        const retry = vi.fn();
        recoverDesktopSession({ state: "ready", retry }, reconnectRenderer);
        expect(reconnectRenderer).toHaveBeenCalledOnce();
        expect(retry).not.toHaveBeenCalled();

        reconnectRenderer.mockClear();
        recoverDesktopSession({ state: "failed", retry }, reconnectRenderer);
        expect(retry).toHaveBeenCalledOnce();
        expect(reconnectRenderer).not.toHaveBeenCalled();

        expect(() => recoverDesktopSession({ state: "starting", retry }, reconnectRenderer)).toThrow(
            "OAAM Desktop session retry is unavailable",
        );
    });
});
