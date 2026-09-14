import type { DesktopHostStartupSnapshot } from "../bridge/desktop-bridge";
import type { UtilityHostSupervisor, UtilityHostSupervisorEvent } from "./utility-host-supervisor";

export function projectDesktopHostStartup(event: UtilityHostSupervisorEvent): DesktopHostStartupSnapshot | undefined {
    if (event.state === "ready") {
        return event.startupDisposition.mode === "normal"
            ? Object.freeze({ status: "ready" })
            : Object.freeze({ status: "ready", recoveryReason: event.startupDisposition.reason });
    }
    if (event.state === "failed") {
        return Object.freeze({
            status: "failed",
            reasonCode: event.reasonCode === "" ? "desktop.host.failed" : event.reasonCode,
        });
    }
    if (event.state === "starting") {
        return event.reasonCode === ""
            ? Object.freeze({ status: "starting" })
            : Object.freeze({
                  status: "recovering",
                  reasonCode: event.reasonCode,
              });
    }
    return undefined;
}

export function recoverDesktopSession(
    supervisor: Pick<UtilityHostSupervisor, "retry" | "state">,
    reconnectRenderer: () => void,
): void {
    if (supervisor.state === "ready") {
        reconnectRenderer();
        return;
    }
    if (supervisor.state === "failed") {
        supervisor.retry();
        return;
    }
    throw new Error("OAAM Desktop session retry is unavailable");
}
