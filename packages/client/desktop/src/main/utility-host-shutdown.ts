import type { DesktopOperationalDiagnosticCode } from "@oaam/app-server-protocol";
import type { UtilityProcessHandle } from "./utility-host-supervisor";

/** Deliver once; a failed delivery cannot imply that external owners have finished. */
export function requestUtilityHostShutdown(
    owner: UtilityProcessHandle | undefined,
    transition: (state: "stopped" | "draining" | "failed", reason: "" | DesktopOperationalDiagnosticCode) => void,
): void {
    if (owner === undefined) {
        transition("stopped", "");
        return;
    }
    transition("draining", "");
    try {
        owner.postMessage(Object.freeze({ type: "shutdown" }));
    } catch {
        transition("failed", "host.shutdown_delivery_failed");
    }
}
